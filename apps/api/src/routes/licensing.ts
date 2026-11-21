import { isValidHttpUrl, newId } from '@extport/shared'
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { activations, extensions, licenseEvents, licenses, plans, type Activation, type Db, type License } from '../db'
import { formatEntitlementResponse, isLicenseEntitled, pickBestLicense } from '../lib/entitlement'
import { createStripeCheckoutSession, StripeApiError, stripeErrorToHttp } from '../lib/stripe-api'
import { loadStripeCredential } from '../lib/stripe-credentials'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireAuth, type AppEnv } from '../middleware/auth'

// ---- Public device activation & check endpoints (called by @extport/sdk) ----
//
// Deliberately unauthenticated: the license key IS the credential (80 bits of
// entropy, see lib/license-key.ts), and there is no tenant in the URL because
// a key already resolves license → plan → extension → tenant on its own.
// `extensionId` is a cross-check against misconfigured extensions, not a
// lookup key. Wire contract and design decisions: docs/licensing.md.
export const licensingPublicRoutes = new Hono<AppEnv>()

// origin '*': these endpoints carry no cookies or tenant credentials, and
// the callers are extension pages whose fetch is CORS-bound unless the
// extension declares host_permissions for our host — a permission burden
// (and, on Firefox/Safari, a user-revocable grant) no tenant should need
// just to verify licenses. The rest of the API stays same-origin, no CORS.
licensingPublicRoutes.use('/activate', cors())
licensingPublicRoutes.use('/check', cors())

// `check` doubles as the heartbeat; only write when the stored value has
// aged past this, so a browser start doesn't always cost a D1 write.
const HEARTBEAT_WRITE_INTERVAL_MS = 12 * 60 * 60 * 1000
// A seat idle past this window is released — but only lazily, at the moment
// another device actually wants the seat (no cron; see docs/licensing.md).
const SEAT_DECAY_MS = 30 * 24 * 60 * 60 * 1000

const codeField = v.pipe(
  v.string('code is required'),
  v.trim(),
  v.toUpperCase(),
  v.minLength(1, 'code is required'),
  v.maxLength(64),
)
const extensionIdField = v.pipe(
  v.string('extensionId is required'),
  v.trim(),
  v.minLength(1, 'extensionId is required'),
  v.maxLength(64),
)
const fingerprintField = v.pipe(
  v.string('fingerprint is required'),
  v.trim(),
  v.minLength(1, 'fingerprint is required'),
  v.maxLength(128),
)

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
  await db
    .update(activations)
    .set({ lastHeartbeatAt: new Date().toISOString() })
    .where(eq(activations.id, activation.id))
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
    .where(
      and(
        eq(activations.licenseId, license.id),
        isNull(activations.releasedAt),
        lt(activations.lastHeartbeatAt, cutoff),
      ),
    )
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

function wireEntitlementData(license: License, tier: string) {
  const base = {
    tier,
    expiresAt: license.entitlementType === 'recurring' ? (license.currentPeriodEnd ?? null) : null,
  }
  if (license.entitlementType === 'recurring') {
    return {
      ...base,
      subscriptionStatus: license.subscriptionStatus,
      cancelAtPeriodEnd: license.cancelAtPeriodEnd,
    }
  }
  return base
}

licensingPublicRoutes.post(
  '/activate',
  describeRoute({
    summary: 'Activate a device with a license key',
    description:
      'Public endpoint called by the extension itself (via @extport/sdk). Idempotent for an already-activated fingerprint.',
    tags: ['Licensing'],
    security: [],
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
    if (!isLicenseEntitled(license)) {
      return c.json({
        success: false,
        message:
          license.entitlementType === 'recurring' && license.status === 'active'
            ? 'subscription is no longer active'
            : 'activation code is no longer active',
      })
    }

    const ok = { success: true, message: 'activated', data: wireEntitlementData(license, plan.tier) }

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

licensingPublicRoutes.post(
  '/check',
  describeRoute({
    summary: 'Check whether a device activation is still valid',
    description: 'Public endpoint; also the heartbeat that keeps a seat alive. Never activates a new device.',
    tags: ['Licensing'],
    security: [],
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

    const inactive = { success: true, data: { isActive: false, ...wireEntitlementData(license, plan.tier) } }
    if (extensionId !== extension.id) return c.json(inactive)
    if (!isLicenseEntitled(license)) return c.json(inactive)

    const [activation] = await db
      .select()
      .from(activations)
      .where(and(eq(activations.licenseId, license.id), eq(activations.deviceFingerprint, fingerprint)))
    if (!activation || activation.releasedAt) return c.json(inactive)

    await touchHeartbeat(db, activation)
    return c.json({ success: true, data: { isActive: true, ...wireEntitlementData(license, plan.tier) } })
  },
)

// ---- Tenant-authenticated server-side entitlement verification API ----

export const licensingTenantRoutes = new Hono<AppEnv>()
licensingTenantRoutes.use('/entitlements', requireAuth, requireActiveTenant)
licensingTenantRoutes.use('/bind', requireAuth, requireActiveTenant)
licensingTenantRoutes.use('/checkout', requireAuth, requireActiveTenant)

const entitlementsQuerySchema = v.object({
  extensionId: v.pipe(
    v.string('extensionId is required'),
    v.trim(),
    v.minLength(1, 'extensionId is required'),
    v.maxLength(64),
  ),
  externalUserId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(255))),
  email: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(255))),
  key: v.optional(v.pipe(v.string(), v.trim(), v.toUpperCase(), v.maxLength(64))),
})

licensingTenantRoutes.get(
  '/entitlements',
  describeRoute({
    summary: 'Verify a user entitlement for an extension (server-side)',
    description:
      'Used by extension backends (with a tenant API key) to check whether a user has an active entitlement by externalUserId (from Stripe client_reference_id), email, or license key. When multiple licenses match, returns the best active entitlement (or most recent inactive license).',
    tags: ['Licensing'],
    responses: {
      200: { description: 'Entitlement status (active: false, tier: "free" if none active)' },
      400: { description: 'Missing extensionId or lookup identifier' },
      404: { description: 'Extension not found' },
    },
  }),
  validator('query', entitlementsQuerySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const query = c.req.valid('query')

    const externalUserId = query.externalUserId || undefined
    const email = query.email || undefined
    const key = query.key || undefined
    if (!externalUserId && !email && !key) {
      return c.json({ error: 'provide at least one of externalUserId, email, or key' }, 400)
    }

    const [extension] = await db
      .select({ id: extensions.id })
      .from(extensions)
      .where(and(eq(extensions.id, query.extensionId), eq(extensions.tenantId, tenant.id)))
    if (!extension) return c.json({ error: 'extension not found' }, 404)

    const matchClauses = []
    if (externalUserId) matchClauses.push(eq(licenses.externalUserId, externalUserId))
    if (email) matchClauses.push(sql`lower(${licenses.buyerEmail}) = lower(${email})`)
    if (key) matchClauses.push(eq(licenses.key, key))

    const rows = await db
      .select({ license: licenses, plan: plans })
      .from(licenses)
      .innerJoin(plans, eq(licenses.planId, plans.id))
      .where(and(eq(licenses.tenantId, tenant.id), eq(plans.extensionId, extension.id), or(...matchClauses)!))

    const best = pickBestLicense(rows)
    return c.json(formatEntitlementResponse(best, tenant.settings.billingPortalUrl ?? null))
  },
)

const bindBodySchema = v.object({
  extensionId: v.pipe(
    v.string('extensionId is required'),
    v.trim(),
    v.minLength(1, 'extensionId is required'),
    v.maxLength(64),
  ),
  key: codeField,
  externalUserId: v.pipe(
    v.string('externalUserId is required'),
    v.trim(),
    v.minLength(1, 'externalUserId is required'),
    v.maxLength(255),
  ),
})

licensingTenantRoutes.post(
  '/bind',
  describeRoute({
    summary: 'Bind an externalUserId to an existing license key',
    description:
      'Associates a user account in your backend with a license purchased while logged out. Idempotent when already bound to the same externalUserId.',
    tags: ['Licensing'],
    responses: {
      200: { description: 'Bound; returns current entitlement' },
      400: { description: 'License is revoked' },
      404: { description: 'Extension or license not found' },
      409: { description: 'License is already bound to a different externalUserId' },
    },
  }),
  validator('json', bindBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    const [extension] = await db
      .select({ id: extensions.id })
      .from(extensions)
      .where(and(eq(extensions.id, body.extensionId), eq(extensions.tenantId, tenant.id)))
    if (!extension) return c.json({ error: 'extension not found' }, 404)

    const [row] = await db
      .select({ license: licenses, plan: plans })
      .from(licenses)
      .innerJoin(plans, eq(licenses.planId, plans.id))
      .where(and(eq(licenses.tenantId, tenant.id), eq(plans.extensionId, extension.id), eq(licenses.key, body.key)))
    if (!row) return c.json({ error: 'license not found' }, 404)
    if (row.license.status !== 'active') return c.json({ error: 'license is no longer active' }, 400)
    if (row.license.externalUserId && row.license.externalUserId !== body.externalUserId) {
      return c.json({ error: 'license is already bound to another user' }, 409)
    }

    let updatedLicense = row.license
    if (row.license.externalUserId !== body.externalUserId) {
      const [saved] = await db
        .update(licenses)
        .set({ externalUserId: body.externalUserId })
        .where(eq(licenses.id, row.license.id))
        .returning()
      if (saved) updatedLicense = saved
    }

    return c.json({
      externalUserId: updatedLicense.externalUserId,
      ...formatEntitlementResponse(
        { license: updatedLicense, plan: row.plan },
        tenant.settings.billingPortalUrl ?? null,
      ),
    })
  },
)

const httpUrlField = (name: string) =>
  v.pipe(
    v.string(`${name} is required`),
    v.trim(),
    v.check((s) => isValidHttpUrl(s), `${name} must be a valid http(s) URL`),
  )

const checkoutBodySchema = v.object({
  extensionId: extensionIdField,
  tier: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32))),
  priceId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
  externalUserId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(255))),
  email: v.optional(v.pipe(v.string(), v.trim(), v.email('email must be a valid email'), v.maxLength(255))),
  successUrl: httpUrlField('successUrl'),
  cancelUrl: httpUrlField('cancelUrl'),
})

licensingTenantRoutes.post(
  '/checkout',
  describeRoute({
    summary: 'Create a Stripe Checkout Session for a one-time perpetual license',
    description:
      'Resolves the perpetual plan and Stripe Price for (extensionId, tier) using the tenant Restricted Key and creates a one-time Checkout Session. For recurring subscriptions, use POST /v1/subscriptions/checkout.',
    tags: ['Licensing'],
    responses: {
      200: { description: 'Checkout URL' },
      400: { description: 'Invalid input, missing perpetual plan/price, or missing Stripe Restricted Key' },
      404: { description: 'Extension not found' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  validator('json', checkoutBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    const [extension] = await db
      .select({ id: extensions.id })
      .from(extensions)
      .where(and(eq(extensions.id, body.extensionId), eq(extensions.tenantId, tenant.id)))
    if (!extension) return c.json({ error: 'extension not found' }, 404)

    const tier = body.tier || 'pro'
    const [plan] = await db
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.tenantId, tenant.id),
          eq(plans.extensionId, extension.id),
          eq(plans.tier, tier),
          eq(plans.entitlementType, 'perpetual'),
        ),
      )
    if (!plan) return c.json({ error: `no perpetual plan found for tier "${tier}" on this extension` }, 400)

    const priceId = body.priceId ?? plan.stripePriceId ?? undefined
    if (!priceId) return c.json({ error: 'no Stripe price configured for this plan' }, 400)

    const cred = await loadStripeCredential(c.env, db, tenant)
    if (!cred?.apiKey) {
      return c.json({ error: 'Stripe Restricted Key is not configured for this tenant' }, 400)
    }

    const externalUserId = body.externalUserId || undefined
    const email = body.email || undefined
    const matchClauses = []
    if (externalUserId) matchClauses.push(eq(licenses.externalUserId, externalUserId))
    if (email) matchClauses.push(sql`lower(${licenses.buyerEmail}) = lower(${email})`)

    let reusableCustomerId: string | null = null
    if (matchClauses.length > 0) {
      const [priorWithCustomer] = await db
        .select({ stripeCustomerId: licenses.stripeCustomerId })
        .from(licenses)
        .where(and(eq(licenses.tenantId, tenant.id), isNotNull(licenses.stripeCustomerId), or(...matchClauses)!))
        .orderBy(desc(licenses.createdAt), desc(licenses.id))
        .limit(1)
      reusableCustomerId = priorWithCustomer?.stripeCustomerId ?? null
    }

    try {
      const session = await createStripeCheckoutSession(cred.apiKey, {
        mode: 'payment',
        priceId,
        planId: plan.id,
        customerId: reusableCustomerId,
        customerEmail: email,
        externalUserId,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
      })
      return c.json({ action: 'checkout', url: session.url, sessionId: session.id })
    } catch (err) {
      if (err instanceof StripeApiError) {
        const mapped = stripeErrorToHttp(err)
        return c.json(mapped.body, mapped.status)
      }
      throw err
    }
  },
)

export default licensingPublicRoutes
