import { isValidHttpUrl } from '@extport/shared'
import { and, desc, eq, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { extensions, plans, subscriptions } from '../db'
import { createMagicLink } from '../lib/buyer-session'
import { formatSubscriptionEntitlement, isSubscriptionEntitled, pickBestSubscription } from '../lib/entitlement'
import { createStripeCheckoutSession, resolveStripeApiBase, StripeApiError, stripeErrorToHttp } from '../lib/stripe-api'
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
const SUBSCRIPTION_STATUS_FILTERS = [...SUBSCRIPTION_STATUSES, 'canceling'] as const

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
      'Newest first with keyset pagination (?limit=20&before=createdAt~id or ?cursor=createdAt~id). Filter by ?extension=, ?status= (trialing, active, past_due, canceled, expired, or canceling), or ?search= (case-insensitive substring of buyerEmail or externalUserId).',
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
      if (!(SUBSCRIPTION_STATUS_FILTERS as readonly string[]).includes(status)) {
        return c.json({ error: `status must be one of: ${SUBSCRIPTION_STATUS_FILTERS.join(', ')}` }, 400)
      }
      if (status === 'canceling') {
        filters.push(
          and(inArray(subscriptions.status, ['active', 'trialing']), eq(subscriptions.cancelAtPeriodEnd, true))!,
        )
      } else {
        filters.push(eq(subscriptions.status, status as (typeof SUBSCRIPTION_STATUSES)[number]))
      }
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
        billingInterval: plans.billingInterval,
        extensionName: extensions.name,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .innerJoin(extensions, eq(extensions.id, subscriptions.extensionId))
      .where(and(...filters))
      .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
      .limit(limit + 1)

    const slice = rows.slice(0, limit)
    const pendingPlanIds = [
      ...new Set(slice.map((r) => r.subscription.pendingPlanId).filter((id): id is string => Boolean(id))),
    ]
    const pendingPlanMap = new Map<
      string,
      { tier: string; billingInterval: typeof plans.$inferSelect.billingInterval }
    >()
    if (pendingPlanIds.length > 0) {
      const pendingPlans = await db
        .select({ id: plans.id, tier: plans.tier, billingInterval: plans.billingInterval })
        .from(plans)
        .where(and(eq(plans.tenantId, tenant.id), inArray(plans.id, pendingPlanIds)))
      for (const p of pendingPlans) {
        pendingPlanMap.set(p.id, { tier: p.tier, billingInterval: p.billingInterval })
      }
    }

    const page = slice.map((r) => ({
      ...r.subscription,
      tier: r.tier,
      billingInterval: r.billingInterval,
      pendingPlan: r.subscription.pendingPlanId ? (pendingPlanMap.get(r.subscription.pendingPlanId) ?? null) : null,
      extensionName: r.extensionName,
    }))
    const last = page[page.length - 1]
    const nextCursor = rows.length > limit ? `${last!.createdAt}~${last!.id}` : null
    return c.json({ subscriptions: page, nextCursor })
  },
)

route.get(
  '/overview',
  describeRoute({
    tags: ['Subscriptions'],
    summary: 'Subscription KPI overview across all extensions',
    description:
      'Current subscription counts by status, estimated monthly recurring revenue (MRR) in the dominant plan currency across active subscriptions (yearly plans normalized by /12), and new subscriptions started in the last 30 days vs the previous 30 days.',
    responses: { 200: { description: 'OK' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')

    const grouped = await db
      .select({
        status: subscriptions.status,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        currency: plans.currency,
        billingInterval: plans.billingInterval,
        count: sql<number>`count(*)`,
        sumAmount: sql<number>`coalesce(sum(${plans.amount}), 0)`,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(subscriptions.tenantId, tenant.id))
      .groupBy(subscriptions.status, subscriptions.cancelAtPeriodEnd, plans.currency, plans.billingInterval)

    const counts = {
      active: 0,
      trialing: 0,
      pastDue: 0,
      canceling: 0,
      canceled: 0,
      expired: 0,
      total: 0,
    }

    const mrrByCurrency = new Map<string, number>()
    for (const row of grouped) {
      const n = Number(row.count)
      counts.total += n
      if (row.status === 'active') counts.active += n
      else if (row.status === 'trialing') counts.trialing += n
      else if (row.status === 'past_due') counts.pastDue += n
      else if (row.status === 'canceled') counts.canceled += n
      else if (row.status === 'expired') counts.expired += n

      if ((row.status === 'active' || row.status === 'trialing') && row.cancelAtPeriodEnd) {
        counts.canceling += n
      }

      if (row.status === 'active') {
        const monthly = row.billingInterval === 'year' ? Math.round(Number(row.sumAmount) / 12) : Number(row.sumAmount)
        const curr = row.currency.toLowerCase()
        mrrByCurrency.set(curr, (mrrByCurrency.get(curr) ?? 0) + monthly)
      }
    }

    const sortedCurrencies = [...mrrByCurrency.entries()].sort((a, b) => b[1] - a[1])
    const currency = sortedCurrencies[0]?.[0] ?? 'usd'
    const mrr = sortedCurrencies[0]?.[1] ?? 0
    const hasMultipleCurrencies = sortedCurrencies.length > 1

    const nowMs = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const last30dStart = new Date(nowMs - 30 * dayMs).toISOString()
    const prev30dStart = new Date(nowMs - 60 * dayMs).toISOString()

    const [recent] = await db
      .select({
        newLast30d: sql<number>`coalesce(sum(case when ${subscriptions.createdAt} >= ${last30dStart} then 1 else 0 end), 0)`,
        newPrev30d: sql<number>`coalesce(sum(case when ${subscriptions.createdAt} >= ${prev30dStart} and ${subscriptions.createdAt} < ${last30dStart} then 1 else 0 end), 0)`,
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.tenantId, tenant.id), gte(subscriptions.createdAt, prev30dStart)))

    return c.json({
      currency,
      mrr,
      hasMultipleCurrencies,
      counts,
      newLast30d: Number(recent?.newLast30d ?? 0),
      newPrev30d: Number(recent?.newPrev30d ?? 0),
    })
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
  successUrl: v.optional(httpUrlField('successUrl')),
  cancelUrl: v.optional(httpUrlField('cancelUrl')),
})

route.post(
  '/checkout',
  describeRoute({
    tags: ['Subscriptions'],
    summary: 'Create a duplicate-guarded Stripe Checkout Session for a subscription',
    description:
      'Resolves the active recurring plan and Stripe Price by planId or (extensionId, tier, interval) using the connected Stripe account. Checks if the user already has an entitled subscription for this extension and returns a one-click Extport Buyer Portal link instead of creating a duplicate. Defaults successUrl to the Extport checkout confirmation page when omitted.',
    responses: {
      200: { description: 'Checkout URL or Extport Buyer Portal redirect (already_subscribed)' },
      400: { description: 'Invalid input, disabled/missing plan/price, or Stripe not connected' },
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
      if (!plan.active) return c.json({ error: 'this plan is currently disabled' }, 400)
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
            eq(plans.active, true),
            ...(normalizedInterval ? [eq(plans.billingInterval, normalizedInterval)] : []),
          ),
        )
      if (matching.length === 0) {
        return c.json({ error: `no active recurring plan found for tier "${tier}" on this extension` }, 400)
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

    const portalBase = c.env.PORTAL_URL.replace(/\/+$/, '')
    const successUrl = body.successUrl ?? `${portalBase}/purchase/success?session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = body.cancelUrl ?? `${portalBase}/portal`

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
          const portalEmail = best?.subscription.buyerEmail ?? email
          if (portalEmail) {
            const link = await createMagicLink(db, portalEmail)
            return c.json({
              action: 'portal',
              url: `${portalBase}/portal?code=${link.code}`,
              reason: 'already_subscribed',
            })
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
        successUrl,
        cancelUrl,
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
  returnUrl: v.optional(httpUrlField('returnUrl')),
})

route.post(
  '/portal',
  describeRoute({
    tags: ['Subscriptions'],
    summary: 'Create a one-click Extport Buyer Portal sign-in link for a subscriber',
    description:
      'Resolves the best matching subscription for externalUserId or email and mints a single-use magic-link URL into the Extport Buyer Portal.',
    responses: {
      200: { description: 'Extport Buyer Portal URL' },
      400: { description: 'Missing lookup identifier or invalid returnUrl' },
      404: { description: 'Extension not found or no matching subscriber found' },
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

    const best = pickBestSubscription(rows)
    if (!best) {
      return c.json({ error: 'no billing portal available for this user' }, 404)
    }

    const portalBase = c.env.PORTAL_URL.replace(/\/+$/, '')
    const link = await createMagicLink(db, best.subscription.buyerEmail)
    return c.json({ url: `${portalBase}/portal?code=${link.code}` })
  },
)

export default route
