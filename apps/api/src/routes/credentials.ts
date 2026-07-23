import { decryptJson, encryptJson, newId, STORES, type Store } from '@extport/shared'
import {
  credentialHint,
  CredentialValidationError,
  getAdapter,
  parseCredentials,
} from '@extport/store-adapters'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { publishTargets, storeCredentials } from '../db'
import { statusFor } from '../lib/credential-status'
import { tenantDek } from '../lib/kms'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireSession, type AppEnv } from '../middleware/auth'

const route = new Hono<AppEnv>()

// Credentials are dashboard-managed only; an API key must never read or write them.
route.use('*', requireSession, requireActiveTenant)

function publicView(row: typeof storeCredentials.$inferSelect) {
  return {
    id: row.id,
    store: row.store,
    label: row.label,
    hint: row.hint,
    status: row.status,
    expiresAt: row.expiresAt,
    lastVerifiedAt: row.lastVerifiedAt,
    createdAt: row.createdAt,
  }
}

const credentialViewSchema = v.object({
  id: v.string(),
  store: v.picklist(STORES),
  label: v.string(),
  hint: v.string(),
  status: v.string(),
  expiresAt: v.nullable(v.string()),
  lastVerifiedAt: v.nullable(v.string()),
  createdAt: v.string(),
})

const STORE_MSG = `store must be one of: ${STORES.join(', ')}`
const EXPIRES_AT_MSG = 'expiresAt must be an ISO date'

function isValidDateString(s: string): boolean {
  return !Number.isNaN(new Date(s).getTime())
}

// Normalizes to a real ISO string once validity is confirmed, so route
// handlers never have to re-parse what the schema already checked.
const isoDateSchema = v.pipe(
  v.string(EXPIRES_AT_MSG),
  v.check(isValidDateString, EXPIRES_AT_MSG),
  v.transform((s) => new Date(s).toISOString()),
)

route.get(
  '/',
  describeRoute({
    summary: 'List store credentials',
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: resolver(v.object({ credentials: v.array(credentialViewSchema) })) } } } },
  }),
  async (c) => {
    const rows = await c
      .get('db')
      .select()
      .from(storeCredentials)
      .where(eq(storeCredentials.tenantId, c.get('tenant').id))
      .orderBy(desc(storeCredentials.createdAt))
    return c.json({ credentials: rows.map(publicView) })
  },
)

// `credentials` is deliberately unvalidated here — its shape depends on
// `store` (a discriminated union OpenAPI can't express as cleanly as this
// codebase's own per-adapter parseCredentials already does), so it stays a
// hand-written try/catch below exactly as before.
const createBodySchema = v.object({
  store: v.picklist(STORES, STORE_MSG),
  label: v.optional(v.string()),
  expiresAt: v.optional(isoDateSchema),
  credentials: v.unknown(),
})

route.post(
  '/',
  describeRoute({
    summary: 'Add a store credential',
    description: 'Verified against the live store API before saving, then envelope-encrypted — only the last four characters are ever shown again.',
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: resolver(v.object({ credential: credentialViewSchema })) } } },
      422: { description: 'The store rejected the credentials' },
    },
  }),
  validator('json', createBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')
    const store: Store = body.store

    let parsed
    try {
      parsed = parseCredentials(store, body.credentials)
    } catch (err) {
      if (err instanceof CredentialValidationError) return c.json({ error: err.message }, 400)
      throw err
    }

    let check
    try {
      check = await getAdapter(store).verifyCredentials(parsed)
    } catch (err) {
      return c.json({ error: 'store api unavailable, try again later', detail: (err as Error).message }, 502)
    }
    if (!check.ok) {
      return c.json({ error: 'credential verification failed', reason: check.reason }, 422)
    }

    const dek = await tenantDek(c.env, tenant)
    const encryptedPayload = await encryptJson(dek, parsed)
    const finalExpiresAt = check.expiresAt ? check.expiresAt.toISOString() : (body.expiresAt ?? null)

    const id = newId('storeCredential')
    await db.insert(storeCredentials).values({
      id,
      tenantId: tenant.id,
      store,
      label: body.label?.trim() || store,
      hint: credentialHint(store, parsed),
      encryptedPayload,
      keyVersion: tenant.dekKeyVersion,
      expiresAt: finalExpiresAt,
      lastVerifiedAt: new Date().toISOString(),
      status: statusFor(true, finalExpiresAt),
    })
    const [created] = await db.select().from(storeCredentials).where(eq(storeCredentials.id, id))
    return c.json({ credential: publicView(created!) }, 201)
  },
)

const patchBodySchema = v.object({
  label: v.optional(v.string()),
  expiresAt: v.optional(v.nullable(isoDateSchema)),
  credentials: v.unknown(),
})

// Rotates the secret in place — same id, so any publish_target referencing
// it keeps working with no re-linking. The store itself can't change (that's
// a different credential, not a rotation); everything else about creating
// one applies unchanged: fresh input verified against the live store API,
// never the previous plaintext.
route.patch(
  '/:id',
  describeRoute({
    summary: 'Rotate a store credential',
    description: 'Same shape as adding one — verified the same way, kept under the same id.',
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: resolver(v.object({ credential: credentialViewSchema })) } } },
      404: { description: 'Not found' },
      422: { description: 'The store rejected the credentials' },
    },
  }),
  validator('json', patchBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const [row] = await db
      .select()
      .from(storeCredentials)
      .where(and(eq(storeCredentials.tenantId, tenant.id), eq(storeCredentials.id, c.req.param('id'))))
    if (!row) return c.json({ error: 'not found' }, 404)

    const body = c.req.valid('json')
    const expiresAt = body.expiresAt !== undefined ? body.expiresAt : row.expiresAt

    let parsed
    try {
      parsed = parseCredentials(row.store, body.credentials)
    } catch (err) {
      if (err instanceof CredentialValidationError) return c.json({ error: err.message }, 400)
      throw err
    }

    let check
    try {
      check = await getAdapter(row.store).verifyCredentials(parsed)
    } catch (err) {
      return c.json({ error: 'store api unavailable, try again later', detail: (err as Error).message }, 502)
    }
    if (!check.ok) {
      return c.json({ error: 'credential verification failed', reason: check.reason }, 422)
    }

    const dek = await tenantDek(c.env, tenant)
    const encryptedPayload = await encryptJson(dek, parsed)
    const finalExpiresAt = check.expiresAt ? check.expiresAt.toISOString() : expiresAt

    await db
      .update(storeCredentials)
      .set({
        label: body.label?.trim() || row.label,
        hint: credentialHint(row.store, parsed),
        encryptedPayload,
        keyVersion: tenant.dekKeyVersion,
        expiresAt: finalExpiresAt,
        lastVerifiedAt: new Date().toISOString(),
        status: statusFor(true, finalExpiresAt),
      })
      .where(eq(storeCredentials.id, row.id))

    const [updated] = await db.select().from(storeCredentials).where(eq(storeCredentials.id, row.id))
    return c.json({ credential: publicView(updated!) })
  },
)

route.post(
  '/:id/verify',
  describeRoute({
    summary: 'Re-verify a store credential',
    description: 'Re-checks the already-saved credential against the live store API and updates its status — does not accept new credential input.',
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: resolver(v.object({ credential: credentialViewSchema, reason: v.optional(v.string()) })) } } },
      404: { description: 'Not found' },
    },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const [row] = await db
      .select()
      .from(storeCredentials)
      .where(and(eq(storeCredentials.tenantId, tenant.id), eq(storeCredentials.id, c.req.param('id'))))
    if (!row) return c.json({ error: 'not found' }, 404)

    const dek = await tenantDek(c.env, tenant)
    const credentials = await decryptJson(dek, row.encryptedPayload)

    let check
    try {
      check = await getAdapter(row.store).verifyCredentials(parseCredentials(row.store, credentials))
    } catch (err) {
      return c.json({ error: 'store api unavailable, try again later', detail: (err as Error).message }, 502)
    }

    const status = statusFor(check.ok, row.expiresAt)
    await db
      .update(storeCredentials)
      .set({ status, lastVerifiedAt: new Date().toISOString() })
      .where(eq(storeCredentials.id, row.id))
    const [updated] = await db.select().from(storeCredentials).where(eq(storeCredentials.id, row.id))
    return c.json({ credential: publicView(updated!), reason: check.ok ? undefined : check.reason })
  },
)

route.delete(
  '/:id',
  describeRoute({
    summary: 'Delete a store credential',
    description: 'Refused while a publish target still references it — remove the target first.',
    responses: { 200: { description: 'OK' }, 404: { description: 'Not found' }, 409: { description: 'Still in use by a publish target' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const [row] = await db
      .select({ id: storeCredentials.id })
      .from(storeCredentials)
      .where(and(eq(storeCredentials.tenantId, tenant.id), eq(storeCredentials.id, c.req.param('id'))))
    if (!row) return c.json({ error: 'not found' }, 404)

    const referencing = await db
      .select({ id: publishTargets.id })
      .from(publishTargets)
      .where(eq(publishTargets.credentialId, row.id))
      .limit(1)
    if (referencing.length > 0) {
      return c.json({ error: 'credential is used by a publish target — remove the target first' }, 409)
    }

    await db.delete(storeCredentials).where(eq(storeCredentials.id, row.id))
    return c.json({ ok: true })
  },
)

export default route
