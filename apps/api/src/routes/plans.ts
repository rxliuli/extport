import { newId } from '@extport/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { extensions, plans } from '../db'
import {
  archiveStripePrice,
  createStripePrice,
  createStripeProduct,
  StripeApiError,
  stripeErrorToHttp,
} from '../lib/stripe-api'
import { loadStripeCredential } from '../lib/stripe-credentials'
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
  monthlyAmount: v.optional(amountField),
  yearlyAmount: v.optional(amountField),
  stripeProductId: v.optional(stripeIdField),
  stripePriceId: v.optional(stripeIdField),
  stripeMonthlyPriceId: v.optional(stripeIdField),
  stripeYearlyPriceId: v.optional(stripeIdField),
})

function validatePricingFieldsForType(
  entitlementType: 'perpetual' | 'balance' | 'recurring',
  body: {
    amount?: number | null
    monthlyAmount?: number | null
    yearlyAmount?: number | null
    stripePriceId?: string | null
    stripeMonthlyPriceId?: string | null
    stripeYearlyPriceId?: string | null
  },
): string | null {
  if (entitlementType === 'perpetual') {
    if (
      body.monthlyAmount !== undefined ||
      body.yearlyAmount !== undefined ||
      body.stripeMonthlyPriceId !== undefined ||
      body.stripeYearlyPriceId !== undefined
    ) {
      return 'monthlyAmount, yearlyAmount, stripeMonthlyPriceId, and stripeYearlyPriceId are only valid for recurring plans'
    }
  } else if (entitlementType === 'recurring') {
    if (body.amount !== undefined || body.stripePriceId !== undefined) {
      return 'amount and stripePriceId are only valid for perpetual plans'
    }
  }
  return null
}

route.post(
  '/',
  describeRoute({
    tags: ['Licensing'],
    summary: 'Create a plan',
    description:
      'One plan per (extension, tier, entitlementType) — a plan has no name of its own. When pricing amounts are provided alongside a Stripe Restricted Key, creates the Stripe Product and Price(s) automatically.',
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

    const mismatch = validatePricingFieldsForType(entitlementType, body)
    if (mismatch) return c.json({ error: mismatch }, 400)

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
        and(eq(plans.extensionId, extension.id), eq(plans.tier, body.tier), eq(plans.entitlementType, entitlementType)),
      )
    if (conflict)
      return c.json({ error: `${entitlementType} plan for tier "${body.tier}" already exists for this extension` }, 409)

    const id = newId('plan')
    const hasAnyAmount =
      body.amount !== undefined || body.monthlyAmount !== undefined || body.yearlyAmount !== undefined
    const effectiveCurrency = hasAnyAmount ? (body.currency ?? 'usd') : (body.currency ?? null)

    const needsOneTimeSync = body.amount !== undefined && !body.stripePriceId
    const needsMonthlySync = body.monthlyAmount !== undefined && !body.stripeMonthlyPriceId
    const needsYearlySync = body.yearlyAmount !== undefined && !body.stripeYearlyPriceId
    const needsStripeSync = needsOneTimeSync || needsMonthlySync || needsYearlySync

    let stripeProductId = body.stripeProductId ?? null
    let stripePriceId = body.stripePriceId ?? null
    let stripeMonthlyPriceId = body.stripeMonthlyPriceId ?? null
    let stripeYearlyPriceId = body.stripeYearlyPriceId ?? null

    if (needsStripeSync) {
      const cred = await loadStripeCredential(c.env, db, tenant)
      if (!cred?.apiKey) {
        return c.json(
          {
            error:
              'Configure your Stripe Restricted Key in Settings first to set managed pricing (or omit amounts to use manual Payment Links)',
          },
          400,
        )
      }
      const apiKey = cred.apiKey
      const currency = effectiveCurrency ?? 'usd'
      try {
        if (!stripeProductId) {
          const product = await createStripeProduct(apiKey, {
            name: `${extension.name} (${body.tier})`,
            metadata: { extport_extension: extension.id, extport_plan: id, extport_tier: body.tier },
          })
          stripeProductId = product.id
        }
        if (needsOneTimeSync) {
          const price = await createStripePrice(apiKey, {
            productId: stripeProductId,
            unitAmount: body.amount!,
            currency,
            nickname: `${body.tier} (one-time)`,
            metadata: { extport_plan: id },
          })
          stripePriceId = price.id
        }
        if (needsMonthlySync) {
          const price = await createStripePrice(apiKey, {
            productId: stripeProductId,
            unitAmount: body.monthlyAmount!,
            currency,
            interval: 'month',
            nickname: `${body.tier} (monthly)`,
            metadata: { extport_plan: id },
          })
          stripeMonthlyPriceId = price.id
        }
        if (needsYearlySync) {
          const price = await createStripePrice(apiKey, {
            productId: stripeProductId,
            unitAmount: body.yearlyAmount!,
            currency,
            interval: 'year',
            nickname: `${body.tier} (yearly)`,
            metadata: { extport_plan: id },
          })
          stripeYearlyPriceId = price.id
        }
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
      // Subscriptions are account-based and do not use device activation seats.
      maxActivations: entitlementType === 'recurring' ? 0 : (body.maxActivations ?? 3),
      currency: effectiveCurrency,
      amount: body.amount ?? null,
      monthlyAmount: body.monthlyAmount ?? null,
      yearlyAmount: body.yearlyAmount ?? null,
      stripeProductId,
      stripePriceId,
      stripeMonthlyPriceId,
      stripeYearlyPriceId,
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
    amount: v.optional(v.nullable(amountField)),
    monthlyAmount: v.optional(v.nullable(amountField)),
    yearlyAmount: v.optional(v.nullable(amountField)),
    stripeProductId: v.optional(v.nullable(stripeIdField)),
    stripePriceId: v.optional(v.nullable(stripeIdField)),
    stripeMonthlyPriceId: v.optional(v.nullable(stripeIdField)),
    stripeYearlyPriceId: v.optional(v.nullable(stripeIdField)),
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
      'Updates maxActivations and/or pricing. When amounts change with a Stripe Restricted Key configured, creates a new Stripe Price and archives the previous one.',
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

    const mismatch = validatePricingFieldsForType(existing.entitlementType, body)
    if (mismatch) return c.json({ error: mismatch }, 400)

    let cachedKey: string | null | undefined
    const getApiKey = async (): Promise<string | null> => {
      if (cachedKey !== undefined) return cachedKey
      const cred = await loadStripeCredential(c.env, db, tenant)
      cachedKey = cred?.apiKey ?? null
      return cachedKey
    }

    let nextStripeProductId = body.stripeProductId !== undefined ? body.stripeProductId : existing.stripeProductId
    const ensureStripeProduct = async (apiKey: string): Promise<string> => {
      if (nextStripeProductId) return nextStripeProductId
      const product = await createStripeProduct(apiKey, {
        name: `${row.extensionName} (${existing.tier})`,
        metadata: {
          extport_extension: existing.extensionId,
          extport_plan: existing.id,
          extport_tier: existing.tier,
        },
      })
      nextStripeProductId = product.id
      return product.id
    }

    const currencyChanged = body.currency !== undefined && body.currency !== (existing.currency ?? 'usd')
    const nextCurrency = body.currency ?? existing.currency ?? 'usd'

    async function syncPriceSlot(opts: {
      existingAmount: number | null
      existingPriceId: string | null
      bodyAmount: number | null | undefined
      bodyPriceId: string | null | undefined
      interval?: 'month' | 'year'
      nickname: string
    }): Promise<{ amount: number | null; priceId: string | null } | Response> {
      const nextAmount = opts.bodyAmount !== undefined ? opts.bodyAmount : opts.existingAmount
      if (opts.bodyPriceId !== undefined) {
        return { amount: nextAmount, priceId: opts.bodyPriceId }
      }
      if (nextAmount === null) {
        // Only archive & clear when the caller explicitly cleared the amount to null;
        // leave manually-linked stripePriceId rows (where amount was already null) intact.
        if (opts.bodyAmount === null) {
          if (opts.existingPriceId) {
            const apiKey = await getApiKey()
            if (apiKey) {
              try {
                await archiveStripePrice(apiKey, opts.existingPriceId)
              } catch {
                // Best-effort archive — ignore if already archived or missing.
              }
            }
          }
          return { amount: null, priceId: null }
        }
        return { amount: null, priceId: opts.existingPriceId }
      }

      const shouldSync =
        (opts.bodyAmount !== undefined &&
          (opts.bodyAmount !== opts.existingAmount || currencyChanged || !opts.existingPriceId)) ||
        (currencyChanged && opts.existingAmount !== null)
      if (!shouldSync) {
        return { amount: nextAmount, priceId: opts.existingPriceId }
      }

      const apiKey = await getApiKey()
      if (!apiKey) {
        return c.json(
          {
            error:
              'Configure your Stripe Restricted Key in Settings first to update managed pricing (or pass stripePriceId manually)',
          },
          400,
        )
      }

      const productId = await ensureStripeProduct(apiKey)
      const created = await createStripePrice(apiKey, {
        productId,
        unitAmount: nextAmount,
        currency: nextCurrency,
        interval: opts.interval,
        nickname: opts.nickname,
        metadata: { extport_plan: existing.id },
      })
      if (opts.existingPriceId && opts.existingPriceId !== created.id) {
        try {
          await archiveStripePrice(apiKey, opts.existingPriceId)
        } catch {
          // Best-effort archive — ignore if already archived in Stripe.
        }
      }
      return { amount: nextAmount, priceId: created.id }
    }

    try {
      const oneTime = await syncPriceSlot({
        existingAmount: existing.amount,
        existingPriceId: existing.stripePriceId,
        bodyAmount: body.amount,
        bodyPriceId: body.stripePriceId,
        nickname: `${existing.tier} (one-time)`,
      })
      if (oneTime instanceof Response) return oneTime

      const monthly = await syncPriceSlot({
        existingAmount: existing.monthlyAmount,
        existingPriceId: existing.stripeMonthlyPriceId,
        bodyAmount: body.monthlyAmount,
        bodyPriceId: body.stripeMonthlyPriceId,
        interval: 'month',
        nickname: `${existing.tier} (monthly)`,
      })
      if (monthly instanceof Response) return monthly

      const yearly = await syncPriceSlot({
        existingAmount: existing.yearlyAmount,
        existingPriceId: existing.stripeYearlyPriceId,
        bodyAmount: body.yearlyAmount,
        bodyPriceId: body.stripeYearlyPriceId,
        interval: 'year',
        nickname: `${existing.tier} (yearly)`,
      })
      if (yearly instanceof Response) return yearly

      const hasAnyNextAmount = oneTime.amount !== null || monthly.amount !== null || yearly.amount !== null
      const storedCurrency =
        body.currency !== undefined
          ? body.currency
          : hasAnyNextAmount
            ? (existing.currency ?? 'usd')
            : existing.currency

      await db
        .update(plans)
        .set({
          maxActivations: body.maxActivations ?? existing.maxActivations,
          currency: storedCurrency,
          amount: oneTime.amount,
          monthlyAmount: monthly.amount,
          yearlyAmount: yearly.amount,
          stripeProductId: nextStripeProductId,
          stripePriceId: oneTime.priceId,
          stripeMonthlyPriceId: monthly.priceId,
          stripeYearlyPriceId: yearly.priceId,
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
