import { isValidHttpUrl } from '@extport/shared'
import { and, desc, eq, isNotNull, lt, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { extensions, plans, subscriptions } from '../db'
import { formatSubscriptionEntitlement, isSubscriptionEntitled, pickBestSubscription } from '../lib/entitlement'
import {
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  resolveStripeApiBase,
  StripeApiError,
  stripeErrorToHttp,
} from '../lib/stripe-api'
import { loadStripeCredential, resolveStripeAuth } from '../lib/stripe-credentials'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireAuth, type AppEnv } from '../middleware/auth'

// Dedicated account-based recurring subscription API.
// Cleanly separated from one-time activation-code licenses (/v1/licenses & /v1/licensing).
const route = new Hono<AppEnv>()

route.use('*', requireAuth, requireActiveTenant)

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'expired'] as const

const extensionIdField = v.pipe(
  v.string('extensionId is required'),
  v.trim(),
  v.minLength(1, 'extensionId is required'),
  v.maxLength(64),
)

const httpUrlField = (name: string) =>
  v.pipe(
    v.string(`${name} is required`),
    v.trim(),
    v.check((s) => isValidHttpUrl(s), `${name} must be a valid http(s) URL`),
  )

route.get(
  '/',
  describeRoute({
    tags: ['Subscriptions'],
    summary: 'List subscriptions',
    description:
      'Newest first with keyset pagination (?limit=20&before=createdAt~id or ?cursor=createdAt~id). Filter by ?extension=, ?status=, or ?search= (case-insensitive substring of buyerEmail or externalUserId).',
    responses: { 200: { description: 'OK' }, 400: { description: 'Invalid cursor or status filter' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const extensionId = c.req.query('extension')
    const status = c.req.query('status')
    const search = c.req.query('search')?.trim()
    const cursor = c.req.query('before') ?? c.req.query('cursor')
    const rawLimit = Number(c.req.query('limit'))
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE

    const filters = [eq(subscriptions.tenantId, tenant.id)]
    if (extensionId) filters.push(eq(subscriptions.extensionId, extensionId))
    if (status) {
      if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(status)) {
        return c.json({ error: `status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}` }, 400)
      }
      filters.push(eq(subscriptions.status, status as (typeof SUBSCRIPTION_STATUSES)[number]))
    }
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
      filters.push(
        or(
          sql`${subscriptions.buyerEmail} like ${pattern} escape '\\'`,
          sql`coalesce(${subscriptions.externalUserId}, '') like ${pattern} escape '\\'`,
        )!,
      )
    }
    if (cursor) {
      const sep = cursor.lastIndexOf('~')
      if (sep === -1) return c.json({ error: 'cursor must be "createdAt~id"' }, 400)
      const createdAt = cursor.slice(0, sep)
      const id = cursor.slice(sep + 1)
      filters.push(
        or(
          lt(subscriptions.createdAt, createdAt),
          and(eq(subscriptions.createdAt, createdAt), lt(subscriptions.id, id)),
        )!,
      )
    }

    const rows = await db
      .select({
        subscription: subscriptions,
        tier: plans.tier,
        extensionName: extensions.name,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .innerJoin(extensions, eq(extensions.id, subscriptions.extensionId))
      .where(and(...filters))
      .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
      .limit(limit + 1)

    const page = rows.slice(0, limit).map((r) => ({
      ...r.subscription,
      tier: r.tier,
      extensionName: r.extensionName,
    }))
    const last = page[page.length - 1]
    const nextCursor = rows.length > limit ? `${last!.createdAt}~${last!.id}` : null
    return c.json({ subscriptions: page, nextCursor })
  },
)

const entitlementsQuerySchema = v.object({
  extensionId: extensionIdField,
  externalUserId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(255))),
  email: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(255))),
})

route.get(
  '/entitlements',
  describeRoute({
    tags: ['Subscriptions'],
    summary: 'Verify a user subscription entitlement (server-side)',
    description:
      'Used by extension backends (with a tenant API key) to check whether a user has an active subscription by externalUserId (from Stripe client_reference_id) or email (case-insensitive).',
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
    if (!externalUserId && !email) {
      return c.json({ error: 'provide at least one of externalUserId or email' }, 400)
    }

    const [extension] = await db
      .select({ id: extensions.id })
      .from(extensions)
      .where(and(eq(extensions.id, query.extensionId), eq(extensions.tenantId, tenant.id)))
    if (!extension) return c.json({ error: 'extension not found' }, 404)

    const matchClauses = []
    if (externalUserId) matchClauses.push(eq(subscriptions.externalUserId, externalUserId))
    if (email) matchClauses.push(sql`lower(${subscriptions.buyerEmail}) = lower(${email})`)

    const rows = await db
      .select({ subscription: subscriptions, plan: plans })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .where(
        and(eq(subscriptions.tenantId, tenant.id), eq(subscriptions.extensionId, extension.id), or(...matchClauses)!),
      )

    const best = pickBestSubscription(rows)
    return c.json(formatSubscriptionEntitlement(best))
  },
)

const checkoutBodySchema = v.object({
  extensionId: extensionIdField,
  planId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
  tier: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32))),
  interval: v.optional(
    v.picklist(['month', 'year', 'monthly', 'yearly'], 'interval must be "month", "year", "monthly", or "yearly"'),
  ),
  priceId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
  externalUserId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(255))),
  email: v.optional(v.pipe(v.string(), v.trim(), v.email('email must be a valid email'), v.maxLength(255))),
  successUrl: httpUrlField('successUrl'),
  cancelUrl: httpUrlField('cancelUrl'),
})

route.post(
  '/checkout',
  describeRoute({
    tags: ['Subscriptions'],
    summary: 'Create a duplicate-guarded Stripe Checkout Session for a subscription',
    description:
      'Resolves the recurring plan and Stripe Price by planId or (extensionId, tier, interval) using the tenant Restricted Key. Checks if the user already has an entitled subscription for this extension and redirects them to the Stripe Billing Portal instead of creating a duplicate.',
    responses: {
      200: { description: 'Checkout URL or Billing Portal redirect (already_subscribed)' },
      400: { description: 'Invalid input, missing plan/price, or missing Stripe Restricted Key' },
      404: { description: 'Extension not found' },
      409: { description: 'Active subscription exists and no Stripe customer ID is available' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  validator('json', checkoutBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    const [extension] = await db
      .select({ id: extensions.id, licensingEnabled: extensions.licensingEnabled })
      .from(extensions)
      .where(and(eq(extensions.id, body.extensionId), eq(extensions.tenantId, tenant.id)))
    if (!extension) return c.json({ error: 'extension not found' }, 404)
    if (!extension.licensingEnabled) {
      return c.json({ error: 'licensing is disabled for this extension' }, 400)
    }

    let plan: typeof plans.$inferSelect | undefined
    if (body.planId) {
      const [found] = await db
        .select()
        .from(plans)
        .where(
          and(
            eq(plans.id, body.planId),
            eq(plans.tenantId, tenant.id),
            eq(plans.extensionId, extension.id),
            eq(plans.entitlementType, 'recurring'),
          ),
        )
      plan = found
      if (!plan) return c.json({ error: 'recurring plan not found for this extension' }, 400)
    } else {
      const tier = body.tier || 'pro'
      const normalizedInterval =
        body.interval === 'month' || body.interval === 'monthly'
          ? 'month'
          : body.interval === 'year' || body.interval === 'yearly'
            ? 'year'
            : undefined
      const matching = await db
        .select()
        .from(plans)
        .where(
          and(
            eq(plans.tenantId, tenant.id),
            eq(plans.extensionId, extension.id),
            eq(plans.tier, tier),
            eq(plans.entitlementType, 'recurring'),
            ...(normalizedInterval ? [eq(plans.billingInterval, normalizedInterval)] : []),
          ),
        )
      if (matching.length === 0) {
        return c.json({ error: `no recurring plan found for tier "${tier}" on this extension` }, 400)
      }
      if (matching.length > 1) {
        return c.json(
          { error: 'planId or interval ("month" / "year") is required when multiple intervals are configured' },
          400,
        )
      }
      plan = matching[0]!
    }

    const priceId = body.priceId || plan.stripePriceId || undefined
    if (!priceId) return c.json({ error: 'no Stripe price configured for this plan' }, 400)

    const cred = await loadStripeCredential(c.env, db, tenant)
    const stripeAuth = resolveStripeAuth(c.env, cred)
    if (!stripeAuth) {
      return c.json({ error: 'Stripe is not connected for this tenant' }, 400)
    }

    const externalUserId = body.externalUserId || undefined
    const email = body.email || undefined
    const matchClauses = []
    if (externalUserId) matchClauses.push(eq(subscriptions.externalUserId, externalUserId))
    if (email) matchClauses.push(sql`lower(${subscriptions.buyerEmail}) = lower(${email})`)

    let reusableCustomerId: string | null = null
    if (matchClauses.length > 0) {
      const [priorWithCustomer] = await db
        .select({ stripeCustomerId: subscriptions.stripeCustomerId })
        .from(subscriptions)
        .where(
          and(eq(subscriptions.tenantId, tenant.id), isNotNull(subscriptions.stripeCustomerId), or(...matchClauses)!),
        )
        .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
        .limit(1)
      reusableCustomerId = priorWithCustomer?.stripeCustomerId ?? null
    }

    try {
      if (matchClauses.length > 0) {
        const existingExtSubs = await db
          .select({ subscription: subscriptions, plan: plans })
          .from(subscriptions)
          .innerJoin(plans, eq(subscriptions.planId, plans.id))
          .where(
            and(
              eq(subscriptions.tenantId, tenant.id),
              eq(subscriptions.extensionId, extension.id),
              or(...matchClauses)!,
            ),
          )

        const entitled = existingExtSubs.filter((r) => isSubscriptionEntitled(r.subscription))
        if (entitled.length > 0) {
          const best = pickBestSubscription(entitled)
          const portalCustomerId =
            best?.subscription.stripeCustomerId ??
            existingExtSubs.find((r) => r.subscription.stripeCustomerId)?.subscription.stripeCustomerId ??
            reusableCustomerId
          if (portalCustomerId) {
            const portal = await createStripeBillingPortalSession(stripeAuth, {
              customerId: portalCustomerId,
              returnUrl: body.cancelUrl,
              apiBase: resolveStripeApiBase(c.env),
            })
            return c.json({ action: 'portal', url: portal.url, reason: 'already_subscribed' })
          }
          return c.json({ error: 'user already has an active subscription for this extension' }, 409)
        }
      }

      const session = await createStripeCheckoutSession(stripeAuth, {
        mode: 'subscription',
        priceId,
        planId: plan.id,
        customerId: reusableCustomerId,
        customerEmail: email,
        externalUserId,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        apiBase: resolveStripeApiBase(c.env),
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

const portalBodySchema = v.object({
  extensionId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64))),
  externalUserId: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(255))),
  email: v.optional(v.pipe(v.string(), v.trim(), v.email('email must be a valid email'), v.maxLength(255))),
  returnUrl: httpUrlField('returnUrl'),
})

route.post(
  '/portal',
  describeRoute({
    tags: ['Subscriptions'],
    summary: 'Create a one-click Stripe Billing Portal session for a subscriber',
    description:
      'Resolves the best matching subscription with a Stripe customer ID for externalUserId or email and creates a Stripe Billing Portal session via the tenant Restricted Key.',
    responses: {
      200: { description: 'Billing Portal URL' },
      400: { description: 'Missing lookup identifier, invalid returnUrl, or missing Stripe Restricted Key' },
      404: { description: 'Extension not found or no matching subscriber found' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  validator('json', portalBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    const externalUserId = body.externalUserId || undefined
    const email = body.email || undefined
    if (!externalUserId && !email) {
      return c.json({ error: 'provide at least one of externalUserId or email' }, 400)
    }

    if (body.extensionId) {
      const [extension] = await db
        .select({ id: extensions.id })
        .from(extensions)
        .where(and(eq(extensions.id, body.extensionId), eq(extensions.tenantId, tenant.id)))
      if (!extension) return c.json({ error: 'extension not found' }, 404)
    }

    const matchClauses = []
    if (externalUserId) matchClauses.push(eq(subscriptions.externalUserId, externalUserId))
    if (email) matchClauses.push(sql`lower(${subscriptions.buyerEmail}) = lower(${email})`)

    const rows = await db
      .select({ subscription: subscriptions, plan: plans })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .where(
        and(
          eq(subscriptions.tenantId, tenant.id),
          ...(body.extensionId ? [eq(subscriptions.extensionId, body.extensionId)] : []),
          or(...matchClauses)!,
        ),
      )

    const withCustomer = rows.filter((r) => Boolean(r.subscription.stripeCustomerId))
    const best = pickBestSubscription(withCustomer)
    if (!best?.subscription.stripeCustomerId) {
      return c.json({ error: 'no billing portal available for this user' }, 404)
    }

    const cred = await loadStripeCredential(c.env, db, tenant)
    const stripeAuth = resolveStripeAuth(c.env, cred)
    if (!stripeAuth) {
      return c.json({ error: 'Stripe is not connected for this tenant' }, 400)
    }

    try {
      const portal = await createStripeBillingPortalSession(stripeAuth, {
        customerId: best.subscription.stripeCustomerId,
        returnUrl: body.returnUrl,
        apiBase: resolveStripeApiBase(c.env),
      })
      return c.json({ url: portal.url })
    } catch (err) {
      if (err instanceof StripeApiError) {
        const mapped = stripeErrorToHttp(err)
        return c.json(mapped.body, mapped.status)
      }
      throw err
    }
  },
)

export default route
