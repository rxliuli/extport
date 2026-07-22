import { decryptJson, encryptJson, newId, STORES, type Store } from '@extport/shared'
import {
  credentialHint,
  CredentialValidationError,
  getAdapter,
  parseCredentials,
} from '@extport/store-adapters'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { publishTargets, storeCredentials } from '../db'
import { statusFor } from '../lib/credential-status'
import { tenantDek } from '../lib/kms'
import { requireSession, type AppEnv } from '../middleware/auth'

const route = new Hono<AppEnv>()

// Credentials are dashboard-managed only; an API key must never read or write them.
route.use('*', requireSession)

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

route.get('/', async (c) => {
  const rows = await c
    .get('db')
    .select()
    .from(storeCredentials)
    .where(eq(storeCredentials.tenantId, c.get('tenant').id))
    .orderBy(desc(storeCredentials.createdAt))
  return c.json({ credentials: rows.map(publicView) })
})

route.post('/', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const body = await c.req
    .json<{ store?: string; label?: string; expiresAt?: string; credentials?: unknown }>()
    .catch(() => ({}) as Record<string, never>)

  if (!body.store || !(STORES as readonly string[]).includes(body.store)) {
    return c.json({ error: `store must be one of: ${STORES.join(', ')}` }, 400)
  }
  const store = body.store as Store

  let expiresAt: string | null = null
  if (body.expiresAt) {
    const parsedExpiresAt = new Date(body.expiresAt)
    if (Number.isNaN(parsedExpiresAt.getTime())) return c.json({ error: 'expiresAt must be an ISO date' }, 400)
    expiresAt = parsedExpiresAt.toISOString()
  }

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
  const finalExpiresAt = check.expiresAt ? check.expiresAt.toISOString() : expiresAt

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
})

// Rotates the secret in place — same id, so any publish_target referencing
// it keeps working with no re-linking. The store itself can't change (that's
// a different credential, not a rotation); everything else about creating
// one applies unchanged: fresh input verified against the live store API,
// never the previous plaintext.
route.patch('/:id', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const [row] = await db
    .select()
    .from(storeCredentials)
    .where(and(eq(storeCredentials.tenantId, tenant.id), eq(storeCredentials.id, c.req.param('id'))))
  if (!row) return c.json({ error: 'not found' }, 404)

  const body = await c.req
    .json<{ label?: string; expiresAt?: string | null; credentials?: unknown }>()
    .catch(() => ({}) as Record<string, never>)

  let expiresAt = row.expiresAt
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null) {
      expiresAt = null
    } else {
      const parsedExpiresAt = new Date(body.expiresAt)
      if (Number.isNaN(parsedExpiresAt.getTime())) return c.json({ error: 'expiresAt must be an ISO date' }, 400)
      expiresAt = parsedExpiresAt.toISOString()
    }
  }

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
})

route.post('/:id/verify', async (c) => {
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
})

route.delete('/:id', async (c) => {
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
})

export default route
