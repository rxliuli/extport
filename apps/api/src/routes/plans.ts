import { newId } from '@extport/shared'
import { and, eq, isNotNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { extensions, plans } from '../db'
import {
  archiveStripePrice,
  createStripePrice,
  createStripeProduct,
  resolveStripeApiBase,
  StripeApiError,
  stripeErrorToHttp,
} from '../lib/stripe-api'
import { loadStripeCredential, resolveStripeAuth } from '../lib/stripe-credentials'
import type { StripeAuth } from '../lib/stripe-api'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireAuth, type AppEnv } from '../middleware/auth'

// Licensing plan catalog: one row per (extension, tier, entitlementType) —
// a plan has no name of its own, the extension (ext_… id) is its identity.
// See docs/licensing.md.
const route = new Hono<AppEnv>()

route.use('*', requireAuth, requireActiveTenant)

route.get(
  '/',
  describeRoute({ summary: 'List plans', responses: { 200: { description: 'OK' } }, tags: ['Licensing'] }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const extensionId = c.req.query('extension')
    const rows = await db
      .select()
      .from(plans)
      .where(
        extensionId
          ? and(eq(plans.tenantId, tenant.id), eq(plans.extensionId, extensionId))
          : eq(plans.tenantId, tenant.id),
      )
      .orderBy(plans.createdAt)
    return c.json({ plans: rows })
  },
)

const currencyField = v.pipe(
  v.string('currency must be a 3-letter ISO 4217 code'),
  v.trim(),
  v.toLowerCase(),
  v.regex(/^[a-z]{3}$/, 'currency must be a 3-letter ISO 4217 code (e.g. "usd")'),
)

const amountField = v.pipe(
  v.number('amount must be a number'),
  v.integer('amount must be an integer'),
  v.minValue(50, 'amount must be at least 50 in the smallest currency unit'),
  v.maxValue(99_999_999, 'amount is too large'),
)

const stripeIdField = v.pipe(
  v.string('Stripe ID must be a string'),
  v.trim(),
  v.minLength(1, 'Stripe ID must not be empty'),
  v.maxLength(128, 'Stripe ID is too long'),
)

const createPlanBodySchema = v.object({
  extensionId: v.pipe(v.string('extensionId is required'), v.trim(), v.minLength(1, 'extensionId is required')),
  tier: v.pipe(v.string('tier is required'), v.trim(), v.minLength(1, 'tier is required'), v.maxLength(32)),
  entitlementType: v.optional(
    v.picklist(['perpetual', 'recurring'], 'entitlementType must be "perpetual" or "recurring"'),
  ),
  billingInterval: v.optional(
    v.picklist(['one_time', 'month', 'year'], 'billingInterval must be "one_time", "month", or "year"'),
  ),
  maxActivations: v.optional(
    v.pipe(
      v.number('maxActivations must be a number'),
      v.integer('maxActivations must be an integer'),
      v.minValue(1, 'maxActivations must be at least 1'),
      v.maxValue(100, 'maxActivations must be at most 100'),
    ),
  ),
  currency: v.optional(currencyField),
  amount: amountField,
  stripeProductId: v.optional(stripeIdField),
  stripePriceId: v.optional(stripeIdField),
})

function resolveBillingInterval(
  entitlementType: 'perpetual' | 'recurring',
  requested?: 'one_time' | 'month' | 'year',
): { ok: true; value: 'one_time' | 'month' | 'year' } | { ok: false; error: string } {
  if (entitlementType === 'perpetual') {
    if (requested && requested !== 'one_time') {
      return { ok: false, error: 'billingInterval must be "one_time" (or omitted) for perpetual plans' }
    }
    return { ok: true, value: 'one_time' }
  }
  const value = requested ?? 'month'
  if (value === 'one_time') {
    return { ok: false, error: 'billingInterval must be "month" or "year" for recurring plans' }
  }
  return { ok: true, value }
}

function priceNickname(tier: string, billingInterval: 'one_time' | 'month' | 'year'): string {
  if (billingInterval === 'month') return `${tier} (monthly)`
  if (billingInterval === 'year') return `${tier} (yearly)`
  return `${tier} (one-time)`
}

route.post(
  '/',
  describeRoute({
    tags: ['Licensing'],
    summary: 'Create a plan',
    description:
      'One plan per (extension, tier, entitlementType, billingInterval) — each plan maps 1:1 to a Stripe Price under the extension Stripe Product. When amount is provided alongside a Stripe Restricted Key, creates/reuses the Stripe Product and creates the Stripe Price automatically.',
    responses: {
      201: { description: 'Created' },
      400: { description: 'Invalid input or missing Stripe Restricted Key' },
      404: { description: 'Extension not found' },
      409: { description: 'Plan already exists for this extension' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  validator('json', createPlanBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    // The SDK resolves unknown tiers to 'free' — a paid plan named
    // 'free' could never activate anything.
    if (body.tier === 'free') return c.json({ error: 'tier "free" is reserved for the unpaid tier' }, 400)

    const [extension] = await db
      .select({ id: extensions.id, name: extensions.name, billingMode: extensions.billingMode })
      .from(extensions)
      .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, body.extensionId)))
    if (!extension) return c.json({ error: 'extension not found' }, 404)

    const entitlementType =
      body.entitlementType ?? (extension.billingMode === 'subscription' ? 'recurring' : 'perpetual')

    // Enforce mutually exclusive billingMode per extension.
    if (extension.billingMode === 'license' && entitlementType !== 'perpetual') {
      return c.json({ error: 'this extension uses one-time license billing; subscription plans are not allowed' }, 400)
    }
    if (extension.billingMode === 'subscription' && entitlementType !== 'recurring') {
      return c.json({ error: 'this extension uses subscription billing; one-time license plans are not allowed' }, 400)
    }

    const intervalResult = resolveBillingInterval(entitlementType, body.billingInterval)
    if (!intervalResult.ok) return c.json({ error: intervalResult.error }, 400)
    const billingInterval = intervalResult.value

    // When billingMode is still null (legacy/unconfigured), prevent mixing types
    // across plans on the same extension and lock billingMode on first plan.
    if (!extension.billingMode) {
      const [otherTypePlan] = await db
        .select({ entitlementType: plans.entitlementType })
        .from(plans)
        .where(eq(plans.extensionId, extension.id))
        .limit(1)
      if (otherTypePlan && otherTypePlan.entitlementType !== entitlementType) {
        return c.json(
          { error: `cannot mix ${entitlementType} and ${otherTypePlan.entitlementType} plans on the same extension` },
          400,
        )
      }
    }

    const [conflict] = await db
      .select({ id: plans.id })
      .from(plans)
      .where(
        and(
          eq(plans.extensionId, extension.id),
          eq(plans.tier, body.tier),
          eq(plans.entitlementType, entitlementType),
          eq(plans.billingInterval, billingInterval),
        ),
      )
    if (conflict) {
      const intervalLabel = billingInterval === 'one_time' ? 'one-time' : `${billingInterval}ly`
      return c.json({ error: `${intervalLabel} plan for tier "${body.tier}" already exists for this extension` }, 409)
    }

    const id = newId('plan')
    const effectiveCurrency = body.currency ?? 'usd'
    const needsStripeSync = !body.stripePriceId

    let stripeProductId = body.stripeProductId ?? null
    let stripePriceId = body.stripePriceId ?? null

    if (needsStripeSync) {
      const cred = await loadStripeCredential(c.env, db, tenant)
      const stripeAuth = resolveStripeAuth(c.env, cred)
      if (!stripeAuth) {
        return c.json(
          {
            error:
              'Connect your Stripe account in Settings first to sync pricing with Stripe (or pass stripePriceId manually)',
          },
          400,
        )
      }
      try {
        if (!stripeProductId) {
          // 1 Extension = 1 Stripe Product: reuse any Stripe Product already
          // created for this extension before creating a new one.
          const [existingProduct] = await db
            .select({ stripeProductId: plans.stripeProductId })
            .from(plans)
            .where(
              and(eq(plans.tenantId, tenant.id), eq(plans.extensionId, extension.id), isNotNull(plans.stripeProductId)),
            )
            .limit(1)
          if (existingProduct?.stripeProductId) {
            stripeProductId = existingProduct.stripeProductId
          } else {
            const product = await createStripeProduct(stripeAuth, {
              name: extension.name,
              metadata: { extport_extension: extension.id },
              apiBase: resolveStripeApiBase(c.env),
            })
            stripeProductId = product.id
          }
        }
        const price = await createStripePrice(stripeAuth, {
          productId: stripeProductId,
          unitAmount: body.amount,
          currency: effectiveCurrency,
          interval: billingInterval === 'one_time' ? undefined : billingInterval,
          nickname: priceNickname(body.tier, billingInterval),
          metadata: { extport_plan: id },
          apiBase: resolveStripeApiBase(c.env),
        })
        stripePriceId = price.id
      } catch (err) {
        if (err instanceof StripeApiError) {
          const mapped = stripeErrorToHttp(err)
          return c.json(mapped.body, mapped.status)
        }
        throw err
      }
    }

    await db.insert(plans).values({
      id,
      tenantId: tenant.id,
      extensionId: extension.id,
      tier: body.tier,
      entitlementType,
      billingInterval,
      // Subscriptions are account-based and do not use device activation seats.
      maxActivations: entitlementType === 'recurring' ? 0 : (body.maxActivations ?? 3),
      currency: effectiveCurrency,
      amount: body.amount,
      stripeProductId,
      stripePriceId,
    })
    if (!extension.billingMode) {
      await db
        .update(extensions)
        .set({ billingMode: entitlementType === 'recurring' ? 'subscription' : 'license' })
        .where(eq(extensions.id, extension.id))
    }
    const [created] = await db.select().from(plans).where(eq(plans.id, id))
    return c.json({ plan: created }, 201)
  },
)

const patchPlanBodySchema = v.pipe(
  v.object({
    maxActivations: v.optional(
      v.pipe(
        v.number('maxActivations must be a number'),
        v.integer('maxActivations must be an integer'),
        v.minValue(1, 'maxActivations must be at least 1'),
        v.maxValue(100, 'maxActivations must be at most 100'),
      ),
    ),
    currency: v.optional(currencyField),
    amount: v.optional(amountField),
    stripeProductId: v.optional(v.nullable(stripeIdField)),
    stripePriceId: v.optional(v.nullable(stripeIdField)),
  }),
  v.check((b) => Object.values(b).some((val) => val !== undefined), 'provide at least one field to update'),
)

// `tier` is burned into installed extension binaries as the SDK's tier
// table; editing it would fail existing devices' checks. Device limits
// and Stripe pricing/prices are editable here (with snapshot semantics on
// maxActivations and new-Price + best-effort archive on price changes).
route.patch(
  '/:id',
  describeRoute({
    tags: ['Licensing'],
    summary: "Update a plan's device limit or pricing",
    description:
      'Updates maxActivations and/or pricing. When amount changes with a Stripe Restricted Key configured, creates a new Stripe Price and archives the previous one.',
    responses: {
      200: { description: 'OK' },
      400: { description: 'Invalid input or missing Stripe Restricted Key' },
      404: { description: 'Not found' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  validator('json', patchPlanBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    const [row] = await db
      .select({ plan: plans, extensionName: extensions.name })
      .from(plans)
      .innerJoin(extensions, eq(plans.extensionId, extensions.id))
      .where(and(eq(plans.tenantId, tenant.id), eq(plans.id, c.req.param('id'))))
    if (!row) return c.json({ error: 'not found' }, 404)
    const existing = row.plan

    let cachedAuth: StripeAuth | null | undefined
    const getStripeAuth = async (): Promise<StripeAuth | null> => {
      if (cachedAuth !== undefined) return cachedAuth
      const cred = await loadStripeCredential(c.env, db, tenant)
      cachedAuth = resolveStripeAuth(c.env, cred)
      return cachedAuth
    }

    let nextStripeProductId = body.stripeProductId !== undefined ? body.stripeProductId : existing.stripeProductId
    const ensureStripeProduct = async (auth: StripeAuth): Promise<string> => {
      if (nextStripeProductId) return nextStripeProductId
      const [existingProduct] = await db
        .select({ stripeProductId: plans.stripeProductId })
        .from(plans)
        .where(
          and(
            eq(plans.tenantId, tenant.id),
            eq(plans.extensionId, existing.extensionId),
            isNotNull(plans.stripeProductId),
          ),
        )
        .limit(1)
      if (existingProduct?.stripeProductId) {
        nextStripeProductId = existingProduct.stripeProductId
        return nextStripeProductId
      }
      const product = await createStripeProduct(auth, {
        name: row.extensionName,
        metadata: { extport_extension: existing.extensionId },
        apiBase: resolveStripeApiBase(c.env),
      })
      nextStripeProductId = product.id
      return product.id
    }

    const currencyChanged = body.currency !== undefined && body.currency !== existing.currency
    const nextCurrency = body.currency ?? existing.currency
    const nextAmount = body.amount ?? existing.amount
    let nextPriceId = existing.stripePriceId

    try {
      if (body.stripePriceId !== undefined) {
        nextPriceId = body.stripePriceId
      } else {
        const shouldSync =
          (body.amount !== undefined &&
            (body.amount !== existing.amount || currencyChanged || !existing.stripePriceId)) ||
          currencyChanged
        if (shouldSync) {
          const auth = await getStripeAuth()
          if (!auth) {
            return c.json(
              {
                error:
                  'Connect your Stripe account in Settings first to update managed pricing (or pass stripePriceId manually)',
              },
              400,
            )
          }
          const productId = await ensureStripeProduct(auth)
          const interval = existing.billingInterval === 'one_time' ? undefined : existing.billingInterval
          const created = await createStripePrice(auth, {
            productId,
            unitAmount: nextAmount,
            currency: nextCurrency,
            interval,
            nickname: priceNickname(existing.tier, existing.billingInterval),
            metadata: { extport_plan: existing.id },
            apiBase: resolveStripeApiBase(c.env),
          })
          if (existing.stripePriceId && existing.stripePriceId !== created.id) {
            try {
              await archiveStripePrice(auth, existing.stripePriceId, resolveStripeApiBase(c.env))
            } catch {
              // Best-effort archive — ignore if already archived in Stripe.
            }
          }
          nextPriceId = created.id
        }
      }

      await db
        .update(plans)
        .set({
          maxActivations: body.maxActivations ?? existing.maxActivations,
          currency: nextCurrency,
          amount: nextAmount,
          stripeProductId: nextStripeProductId,
          stripePriceId: nextPriceId,
        })
        .where(eq(plans.id, existing.id))
    } catch (err) {
      if (err instanceof StripeApiError) {
        const mapped = stripeErrorToHttp(err)
        return c.json(mapped.body, mapped.status)
      }
      throw err
    }

    const [updated] = await db.select().from(plans).where(eq(plans.id, existing.id))
    return c.json({ plan: updated })
  },
)

export default route
