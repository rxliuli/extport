import { newId } from '@extport/shared'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { activations, extensions, licenseEvents, licenses, plans, type Activation, type Db, type License } from '../db'
import { badRequest } from '../lib/validation'
import type { AppEnv } from '../middleware/auth'

// The public licensing surface — the only extport endpoints called by end
// users' browsers rather than tenants. Deliberately unauthenticated: the
// license key IS the credential (80 bits of entropy, see lib/license-key.ts),
// and there is no tenant in the URL because a key already resolves
// license → plan → extension → tenant on its own. `extensionId` is a cross-check
// against misconfigured extensions, not a lookup key: the code already
// pinned the extension, the id just proves the caller is that extension.
// (The old SDK's productName identity was retired fleet-wide — see
// docs/licensing.md for the history.)
// Wire contract and every design decision here: docs/licensing.md.
const route = new Hono<AppEnv>()

// origin '*': these endpoints carry no cookies or tenant credentials, and
// the callers are extension pages whose fetch is CORS-bound unless the
// extension declares host_permissions for our host — a permission burden
// (and, on Firefox/Safari, a user-revocable grant) no tenant should need
// just to verify licenses. The rest of the API stays same-origin, no CORS.
route.use('*', cors())

// `check` doubles as the heartbeat; only write when the stored value has
// aged past this, so a browser start doesn't always cost a D1 write.
const HEARTBEAT_WRITE_INTERVAL_MS = 12 * 60 * 60 * 1000
// A seat idle past this window is released — but only lazily, at the moment
// another device actually wants the seat (no cron; see docs/licensing.md).
const SEAT_DECAY_MS = 30 * 24 * 60 * 60 * 1000

const codeField = v.pipe(v.string('code is required'), v.trim(), v.toUpperCase(), v.minLength(1, 'code is required'), v.maxLength(64))
const extensionIdField = v.pipe(v.string('extensionId is required'), v.trim(), v.minLength(1, 'extensionId is required'), v.maxLength(64))
const fingerprintField = v.pipe(v.string('fingerprint is required'), v.trim(), v.minLength(1, 'fingerprint is required'), v.maxLength(128))

const activateBodySchema = v.object({
  code: codeField,
  extensionId: extensionIdField,
  fingerprint: fingerprintField,
  // Accepted for compatibility with older clients; the server records
  // only ipHint/uaHint, taken from headers it can trust more.
  deviceInfo: v.optional(v.unknown()),
})

const checkBodySchema = v.object({
  code: codeField,
  extensionId: extensionIdField,
  fingerprint: fingerprintField,
})

async function lookupByCode(db: Db, code: string) {
  const [row] = await db
    .select({ license: licenses, plan: plans, extension: extensions })
    .from(licenses)
    .innerJoin(plans, eq(licenses.planId, plans.id))
    .innerJoin(extensions, eq(plans.extensionId, extensions.id))
    .where(eq(licenses.key, code))
  return row
}

async function touchHeartbeat(db: Db, activation: Activation): Promise<void> {
  const last = activation.lastHeartbeatAt ? new Date(activation.lastHeartbeatAt).getTime() : 0
  if (Date.now() - last < HEARTBEAT_WRITE_INTERVAL_MS) return
  await db.update(activations).set({ lastHeartbeatAt: new Date().toISOString() }).where(eq(activations.id, activation.id))
}

async function countSeats(db: Db, licenseId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(activations)
    .where(and(eq(activations.licenseId, licenseId), isNull(activations.releasedAt)))
  return row?.count ?? 0
}

async function releaseIdleSeats(db: Db, license: License): Promise<number> {
  // ISO-8601 strings from a single formatter compare correctly as text.
  // lastHeartbeatAt is written on every activation, so a NULL (excluded by
  // lt()) can only mean un-imported legacy data — never decay what we
  // can't date.
  const cutoff = new Date(Date.now() - SEAT_DECAY_MS).toISOString()
  const released = await db
    .update(activations)
    .set({ releasedAt: new Date().toISOString() })
    .where(and(eq(activations.licenseId, license.id), isNull(activations.releasedAt), lt(activations.lastHeartbeatAt, cutoff)))
    .returning()
  for (const seat of released) {
    await db.insert(licenseEvents).values({
      id: newId('licenseEvent'),
      tenantId: license.tenantId,
      licenseId: license.id,
      type: 'seat_released',
      payload: { fingerprint: seat.deviceFingerprint, idleSince: seat.lastHeartbeatAt },
    })
  }
  return released.length
}

route.post(
  '/activate',
  describeRoute({
    summary: 'Activate a device with a license key',
    description: 'Public endpoint called by the extension itself (via @extport/sdk). Idempotent for an already-activated fingerprint.',
    responses: { 200: { description: 'Result (success flag in body)' }, 404: { description: 'Licensing not enabled' } },
  }),
  validator('json', activateBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const { code, extensionId, fingerprint } = c.req.valid('json')

    const row = await lookupByCode(db, code)
    if (!row) return c.json({ success: false, message: 'invalid activation code' })
    const { license, plan, extension } = row
    if (!extension.licensingEnabled) return c.json({ error: 'not found' }, 404)
    // The code pinned the extension; the caller must prove it is that extension.
    if (extensionId !== extension.id) {
      return c.json({ success: false, message: 'activation code belongs to a different product' })
    }
    if (license.status !== 'active') return c.json({ success: false, message: 'activation code is no longer active' })

    const ok = { success: true, message: 'activated', data: { tier: plan.tier, expiresAt: null } }

    const [existing] = await db
      .select()
      .from(activations)
      .where(and(eq(activations.licenseId, license.id), eq(activations.deviceFingerprint, fingerprint)))
    if (existing && !existing.releasedAt) {
      await touchHeartbeat(db, existing)
      return c.json(ok)
    }

    // The device needs a seat — brand new, or returning after decay released
    // its old one. Seats are only scarce at this exact moment, which is why
    // decay can run lazily here instead of on a schedule.
    let held = await countSeats(db, license.id)
    if (held >= license.maxActivations) {
      held -= await releaseIdleSeats(db, license)
      if (held >= license.maxActivations) {
        return c.json({ success: false, message: `maximum number of devices (${license.maxActivations}) reached` })
      }
    }

    const nowIso = new Date().toISOString()
    const ipHint = c.req.header('cf-connecting-ip') ?? null
    const uaHint = c.req.header('user-agent') ?? null
    if (existing) {
      await db
        .update(activations)
        .set({ releasedAt: null, activatedAt: nowIso, lastHeartbeatAt: nowIso, ipHint, uaHint })
        .where(eq(activations.id, existing.id))
    } else {
      await db.insert(activations).values({
        id: newId('activation'),
        tenantId: license.tenantId,
        licenseId: license.id,
        deviceFingerprint: fingerprint,
        lastHeartbeatAt: nowIso,
        ipHint,
        uaHint,
      })
    }
    await db.insert(licenseEvents).values({
      id: newId('licenseEvent'),
      tenantId: license.tenantId,
      licenseId: license.id,
      type: 'activated',
      payload: { fingerprint },
    })
    return c.json(ok)
  },
)

route.post(
  '/check',
  describeRoute({
    summary: 'Check whether a device activation is still valid',
    description: 'Public endpoint; also the heartbeat that keeps a seat alive. Never activates a new device.',
    responses: { 200: { description: 'Result (isActive in body)' }, 404: { description: 'Licensing not enabled' } },
  }),
  validator('json', checkBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const { code, extensionId, fingerprint } = c.req.valid('json')

    const row = await lookupByCode(db, code)
    if (!row) return c.json({ success: true, data: { isActive: false, tier: null, expiresAt: null } })
    const { license, plan, extension } = row
    if (!extension.licensingEnabled) return c.json({ error: 'not found' }, 404)

    const inactive = { success: true, data: { isActive: false, tier: plan.tier, expiresAt: null } }
    if (extensionId !== extension.id) return c.json(inactive)
    if (license.status !== 'active') return c.json(inactive)

    const [activation] = await db
      .select()
      .from(activations)
      .where(and(eq(activations.licenseId, license.id), eq(activations.deviceFingerprint, fingerprint)))
    if (!activation || activation.releasedAt) return c.json(inactive)

    await touchHeartbeat(db, activation)
    return c.json({ success: true, data: { isActive: true, tier: plan.tier, expiresAt: null } })
  },
)

export default route
