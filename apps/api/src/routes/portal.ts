import { newId } from '@extport/shared'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import {
  activations,
  extensions,
  licenses,
  magicLinks,
  paymentCredentials,
  plans,
  subscriptionEvents,
  subscriptions,
  tenants,
} from '../db'
import {
  BUYER_SESSION_COOKIE,
  consumeMagicLink,
  createMagicLink,
  destroyBuyerSession,
  resolveBuyerSession,
} from '../lib/buyer-session'
import { sendMagicLinkEmail } from '../lib/licensing-email'
import {
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  listStripeInvoices,
  releaseStripeSubscriptionSchedule,
  resolveStripeApiBase,
  scheduleStripeSubscriptionPlanChange,
  StripeApiError,
  stripeErrorToHttp,
  updateStripeSubscription,
} from '../lib/stripe-api'
import { loadStripeCredential, resolveStripeAuth } from '../lib/stripe-credentials'
import { badRequest } from '../lib/validation'
import type { AppEnv } from '../middleware/auth'

// The buyer-facing surface (portal.extport.dev — read-only by design;
// seat release lives in the tenant dashboard, see docs/licensing.md):
// the checkout success page's time-boxed lookup, magic-link sign-in,
// and the signed-in purchase list.
const route = new Hono<AppEnv>()

// The Checkout Session id rides in the success page's URL — a bearer
// token for the code. High entropy plus this window keeps a leaked
// browser-history entry from mattering later; after expiry the page
// points at the email and the portal.
const PURCHASE_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000

// One magic-link email per address per minute — the endpoint must answer
// identically either way (no address enumeration), so throttling is
// silent too.
const MAGIC_LINK_THROTTLE_MS = 60 * 1000

function safeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString()
  } catch {
    // ignore invalid URLs
  }
  return null
}

route.get(
  '/buy/:planId',
  describeRoute({
    summary: 'Start a hosted Stripe Checkout Session for a plan (public redirect)',
    description:
      'Public checkout entrypoint for static storefronts (no tenant API key needed). Creates a Stripe Checkout Session for the plan using the tenant Restricted Key and redirects (303) to Stripe Checkout.',
    tags: ['Buyer portal'],
    security: [],
    responses: {
      303: { description: 'Redirect to Stripe Checkout' },
      400: { description: 'Licensing disabled, missing Stripe price, or missing Restricted Key' },
      404: { description: 'Plan not found' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  async (c) => {
    const db = c.get('db')
    const [row] = await db
      .select({ plan: plans, extension: extensions, tenant: tenants })
      .from(plans)
      .innerJoin(extensions, eq(plans.extensionId, extensions.id))
      .innerJoin(tenants, eq(extensions.tenantId, tenants.id))
      .where(eq(plans.id, c.req.param('planId')))
    if (!row) return c.json({ error: 'plan not found' }, 404)
    if (!row.extension.licensingEnabled) {
      return c.json({ error: 'licensing is disabled for this extension' }, 400)
    }
    if (!row.plan.stripePriceId) {
      return c.json({ error: 'no Stripe price configured for this plan' }, 400)
    }
    const cred = await loadStripeCredential(c.env, db, row.tenant)
    const stripeAuth = resolveStripeAuth(c.env, cred)
    if (!stripeAuth) {
      return c.json({ error: 'Stripe is not connected for this extension' }, 400)
    }

    const portalBase = c.env.PORTAL_URL.replace(/\/+$/, '')
    const successUrl =
      safeHttpUrl(c.req.query('success_url')) ?? `${portalBase}/purchase/success?session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl =
      safeHttpUrl(c.req.query('cancel_url')) ?? safeHttpUrl(c.req.header('referer')) ?? `${portalBase}/portal`

    try {
      const session = await createStripeCheckoutSession(stripeAuth, {
        mode: row.plan.entitlementType === 'recurring' ? 'subscription' : 'payment',
        priceId: row.plan.stripePriceId,
        planId: row.plan.id,
        successUrl,
        cancelUrl,
        apiBase: resolveStripeApiBase(c.env),
      })
      return c.redirect(session.url, 303)
    } catch (err) {
      if (err instanceof StripeApiError) {
        const mapped = stripeErrorToHttp(err)
        return c.json(mapped.body, mapped.status)
      }
      throw err
    }
  },
)

route.get(
  '/purchase/:sessionId',
  describeRoute({
    summary: 'Look up a fulfilled purchase by Stripe Checkout Session id',
    description:
      'Polled by the checkout success page. Supports both one-time licenses and account-based subscriptions. 404 until the webhook fulfills; 410 once the 24h window has passed.',
    tags: ['Buyer portal'],
    security: [],
    responses: {
      200: { description: 'Fulfilled' },
      404: { description: 'Not fulfilled (yet)' },
      410: { description: 'Window expired' },
    },
  }),
  async (c) => {
    const db = c.get('db')
    const sessionId = c.req.param('sessionId')
    const [licRow] = await db
      .select({ license: licenses, plan: plans, extension: extensions, tenantSettings: tenants.settings })
      .from(licenses)
      .innerJoin(plans, eq(licenses.planId, plans.id))
      .innerJoin(extensions, eq(plans.extensionId, extensions.id))
      .innerJoin(tenants, eq(extensions.tenantId, tenants.id))
      .where(eq(licenses.checkoutSessionId, sessionId))
    if (licRow) {
      if (Date.now() - new Date(licRow.license.createdAt).getTime() > PURCHASE_LOOKUP_WINDOW_MS) {
        return c.json({ error: 'expired' }, 410)
      }
      if (!licRow.license.country) {
        const country = (c.req.raw as Request & { cf?: { country?: string } }).cf?.country
        if (country) await db.update(licenses).set({ country }).where(eq(licenses.id, licRow.license.id))
      }
      return c.json({
        purchase: {
          kind: 'license',
          key: licRow.license.key,
          subscriptionId: null,
          productName: licRow.extension.name,
          tier: licRow.plan.tier,
          billingInterval: licRow.plan.billingInterval,
          entitlementType: licRow.license.entitlementType,
          subscriptionStatus: licRow.license.subscriptionStatus,
          currentPeriodStart: licRow.license.currentPeriodStart,
          currentPeriodEnd: licRow.license.currentPeriodEnd,
          cancelAtPeriodEnd: licRow.license.cancelAtPeriodEnd,
          externalUserId: licRow.license.externalUserId,
          maxActivations: licRow.license.maxActivations,
          buyerEmail: licRow.license.buyerEmail,
          supportUrl: licRow.tenantSettings.supportUrl ?? null,
          billingPortalUrl: licRow.tenantSettings.billingPortalUrl ?? null,
          createdAt: licRow.license.createdAt,
        },
      })
    }

    const [subRow] = await db
      .select({ subscription: subscriptions, plan: plans, extension: extensions, tenantSettings: tenants.settings })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .innerJoin(extensions, eq(subscriptions.extensionId, extensions.id))
      .innerJoin(tenants, eq(extensions.tenantId, tenants.id))
      .where(eq(subscriptions.checkoutSessionId, sessionId))
    if (!subRow) return c.json({ error: 'not found' }, 404)
    if (Date.now() - new Date(subRow.subscription.createdAt).getTime() > PURCHASE_LOOKUP_WINDOW_MS) {
      return c.json({ error: 'expired' }, 410)
    }
    if (!subRow.subscription.country) {
      const country = (c.req.raw as Request & { cf?: { country?: string } }).cf?.country
      if (country) await db.update(subscriptions).set({ country }).where(eq(subscriptions.id, subRow.subscription.id))
    }
    return c.json({
      purchase: {
        kind: 'subscription',
        key: null,
        subscriptionId: subRow.subscription.id,
        productName: subRow.extension.name,
        tier: subRow.plan.tier,
        billingInterval: subRow.plan.billingInterval,
        entitlementType: 'recurring',
        subscriptionStatus: subRow.subscription.status,
        currentPeriodStart: subRow.subscription.currentPeriodStart,
        currentPeriodEnd: subRow.subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subRow.subscription.cancelAtPeriodEnd,
        externalUserId: subRow.subscription.externalUserId,
        maxActivations: 0,
        buyerEmail: subRow.subscription.buyerEmail,
        supportUrl: subRow.tenantSettings.supportUrl ?? null,
        billingPortalUrl: subRow.tenantSettings.billingPortalUrl ?? null,
        createdAt: subRow.subscription.createdAt,
      },
    })
  },
)

const requestLinkBodySchema = v.object({
  email: v.pipe(v.string('email is required'), v.trim(), v.email('email must be a valid email')),
})

route.post(
  '/request-link',
  describeRoute({
    summary: 'Request a portal sign-in link',
    description: 'Always responds ok — whether the address has purchases is never revealed here.',
    tags: ['Buyer portal'],
    security: [],
    responses: { 200: { description: 'OK' } },
  }),
  validator('json', requestLinkBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const { email } = c.req.valid('json')

    const cutoff = new Date(Date.now() - MAGIC_LINK_THROTTLE_MS).toISOString()
    const [recent] = await db
      .select({ id: magicLinks.id })
      .from(magicLinks)
      .where(and(sql`lower(${magicLinks.email}) = lower(${email})`, gt(magicLinks.createdAt, cutoff)))
    if (!recent) {
      const link = await createMagicLink(db, email)
      const url = `${c.env.PORTAL_URL}/portal?code=${link.code}`
      await sendMagicLinkEmail(c.env, email, url)
    }
    return c.json({ ok: true })
  },
)

const verifyBodySchema = v.object({
  code: v.pipe(v.string('code is required'), v.trim(), v.minLength(1, 'code is required')),
})

route.post(
  '/verify',
  describeRoute({
    summary: 'Exchange a magic-link code for a buyer session',
    tags: ['Buyer portal'],
    security: [],
    responses: { 200: { description: 'Signed in' }, 400: { description: 'Invalid, used, or expired' } },
  }),
  validator('json', verifyBodySchema, badRequest),
  async (c) => {
    const session = await consumeMagicLink(c.get('db'), c.req.valid('json').code)
    if (!session) return c.json({ error: 'link is invalid or has expired' }, 400)
    setCookie(c, BUYER_SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      expires: new Date(session.expiresAt),
    })
    return c.json({ email: session.email })
  },
)

async function signedInEmail(c: Context<AppEnv>): Promise<string | null> {
  const token = getCookie(c, BUYER_SESSION_COOKIE)
  if (!token) return null
  return resolveBuyerSession(c.get('db'), token)
}

route.get(
  '/licenses',
  describeRoute({
    summary: "List the signed-in buyer's licenses and devices",
    tags: ['Buyer portal'],
    security: [{ buyerSession: [] }],
    responses: { 200: { description: 'OK' }, 401: { description: 'No buyer session' } },
  }),
  async (c) => {
    const db = c.get('db')
    const email = await signedInEmail(c)
    if (!email) return c.json({ error: 'unauthorized' }, 401)

    // Across tenants on purpose: these are the buyer's own purchases,
    // wherever they were bought.
    const rows = await db
      .select({ license: licenses, plan: plans, extension: extensions, tenantSettings: tenants.settings })
      .from(licenses)
      .innerJoin(plans, eq(licenses.planId, plans.id))
      .innerJoin(extensions, eq(plans.extensionId, extensions.id))
      .innerJoin(tenants, eq(extensions.tenantId, tenants.id))
      .where(sql`lower(${licenses.buyerEmail}) = lower(${email})`)
      .orderBy(desc(licenses.createdAt), desc(licenses.id))

    const subRows = await db
      .select({ subscription: subscriptions, plan: plans, extension: extensions, tenantSettings: tenants.settings })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .innerJoin(extensions, eq(subscriptions.extensionId, extensions.id))
      .innerJoin(tenants, eq(extensions.tenantId, tenants.id))
      .where(sql`lower(${subscriptions.buyerEmail}) = lower(${email})`)
      .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))

    const licenseIds = rows.map((r) => r.license.id)
    const deviceRows = licenseIds.length
      ? await db.select().from(activations).where(inArray(activations.licenseId, licenseIds))
      : []
    const devicesByLicense = new Map<string, typeof deviceRows>()
    for (const device of deviceRows) {
      const list = devicesByLicense.get(device.licenseId)
      if (list) list.push(device)
      else devicesByLicense.set(device.licenseId, [device])
    }

    const tenantIds = [
      ...new Set([...rows.map((r) => r.license.tenantId), ...subRows.map((r) => r.subscription.tenantId)]),
    ]
    const credRows = tenantIds.length
      ? await db
          .select({
            tenantId: paymentCredentials.tenantId,
            stripeAccountId: paymentCredentials.stripeAccountId,
          })
          .from(paymentCredentials)
          .where(and(inArray(paymentCredentials.tenantId, tenantIds), eq(paymentCredentials.provider, 'stripe')))
      : []
    const tenantsWithApiKey = new Set(
      credRows
        .filter((r) => Boolean(r.stripeAccountId && c.env.STRIPE_SECRET_KEY?.trim()))
        .map((r) => r.tenantId),
    )

    const subExtensionIds = [...new Set(subRows.map((r) => r.subscription.extensionId))]
    const extensionRecurringPlans = subExtensionIds.length
      ? await db
          .select()
          .from(plans)
          .where(and(inArray(plans.extensionId, subExtensionIds), eq(plans.entitlementType, 'recurring')))
      : []
    const planById = new Map<string, typeof plans.$inferSelect>()
    for (const r of subRows) planById.set(r.plan.id, r.plan)
    for (const p of extensionRecurringPlans) planById.set(p.id, p)
    const recurringPlansByExtension = new Map<string, (typeof plans.$inferSelect)[]>()
    for (const p of extensionRecurringPlans) {
      if (!p.stripePriceId) continue
      const list = recurringPlansByExtension.get(p.extensionId)
      if (list) list.push(p)
      else recurringPlansByExtension.set(p.extensionId, [p])
    }

    return c.json({
      email,
      licenses: rows.map(({ license, plan, extension, tenantSettings }) => ({
        key: license.key,
        status: license.status,
        entitlementType: license.entitlementType,
        subscriptionStatus: license.subscriptionStatus,
        currentPeriodStart: license.currentPeriodStart,
        currentPeriodEnd: license.currentPeriodEnd,
        cancelAtPeriodEnd: license.cancelAtPeriodEnd,
        externalUserId: license.externalUserId,
        maxActivations: license.maxActivations,
        createdAt: license.createdAt,
        productName: extension.name,
        tier: plan.tier,
        // The selling developer's help and billing links — each license can come
        // from a different tenant, so they travel per license.
        supportUrl: tenantSettings.supportUrl ?? null,
        billingPortalUrl: tenantSettings.billingPortalUrl ?? null,
        canManageBilling:
          (Boolean(license.stripeCustomerId) && tenantsWithApiKey.has(license.tenantId)) ||
          Boolean(tenantSettings.billingPortalUrl),
        devices: (devicesByLicense.get(license.id) ?? []).map((d) => ({
          fingerprint: d.deviceFingerprint,
          activatedAt: d.activatedAt,
          lastHeartbeatAt: d.lastHeartbeatAt,
          releasedAt: d.releasedAt,
        })),
      })),
      subscriptions: subRows.map(({ subscription, plan, extension, tenantSettings }) => {
        const currency = plan.currency.toLowerCase()
        const availablePlans = (recurringPlansByExtension.get(subscription.extensionId) ?? [])
          .filter((p) => p.currency.toLowerCase() === currency)
          .sort((a, b) => a.amount - b.amount || a.billingInterval.localeCompare(b.billingInterval))
          .map((p) => ({
            id: p.id,
            tier: p.tier,
            billingInterval: p.billingInterval,
            amount: p.amount,
            currency: p.currency,
          }))
        const pendingPlanRow = subscription.pendingPlanId ? (planById.get(subscription.pendingPlanId) ?? null) : null
        const pendingPlan = pendingPlanRow
          ? {
              id: pendingPlanRow.id,
              tier: pendingPlanRow.tier,
              billingInterval: pendingPlanRow.billingInterval,
              amount: pendingPlanRow.amount,
              currency: pendingPlanRow.currency,
              effectiveAt: subscription.pendingEffectiveAt,
            }
          : null
        const hasStripeAccess = Boolean(subscription.stripeSubscriptionId) && tenantsWithApiKey.has(subscription.tenantId)
        return {
          id: subscription.id,
          planId: subscription.planId,
          status: subscription.status,
          billingInterval: plan.billingInterval,
          amount: plan.amount,
          currency: plan.currency,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          pendingPlan,
          availablePlans,
          externalUserId: subscription.externalUserId,
          createdAt: subscription.createdAt,
          productName: extension.name,
          tier: plan.tier,
          supportUrl: tenantSettings.supportUrl ?? null,
          billingPortalUrl: tenantSettings.billingPortalUrl ?? null,
          canManageBilling:
            (Boolean(subscription.stripeCustomerId) && tenantsWithApiKey.has(subscription.tenantId)) ||
            Boolean(tenantSettings.billingPortalUrl),
          canCancel: hasStripeAccess,
          canChangePlan:
            hasStripeAccess &&
            (subscription.status === 'active' || subscription.status === 'trialing') &&
            availablePlans.some((p) => p.id !== subscription.planId),
        }
      }),
    })
  },
)

const billingPortalBodySchema = v.pipe(
  v.object({
    key: v.optional(v.pipe(v.string(), v.trim(), v.toUpperCase(), v.minLength(1), v.maxLength(64))),
    subscriptionId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
  }),
  v.check((b) => Boolean(b.key || b.subscriptionId), 'provide key or subscriptionId'),
)

route.post(
  '/billing-portal',
  describeRoute({
    summary: 'Open a one-click Stripe Billing Portal session for a buyer license or subscription',
    tags: ['Buyer portal'],
    security: [{ buyerSession: [] }],
    responses: {
      200: { description: 'Billing Portal URL' },
      401: { description: 'No buyer session' },
      404: { description: 'Purchase not found or no billing portal available' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  validator('json', billingPortalBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const email = await signedInEmail(c)
    if (!email) return c.json({ error: 'unauthorized' }, 401)

    const { key, subscriptionId } = c.req.valid('json')
    let stripeCustomerId: string | null = null
    let tenant: typeof tenants.$inferSelect | null = null

    if (subscriptionId) {
      const [row] = await db
        .select({ subscription: subscriptions, tenant: tenants })
        .from(subscriptions)
        .innerJoin(tenants, eq(subscriptions.tenantId, tenants.id))
        .where(eq(subscriptions.id, subscriptionId))
      if (!row || row.subscription.buyerEmail.toLowerCase() !== email.toLowerCase()) {
        return c.json({ error: 'not found' }, 404)
      }
      stripeCustomerId = row.subscription.stripeCustomerId
      tenant = row.tenant
    } else if (key) {
      const [row] = await db
        .select({ license: licenses, tenant: tenants })
        .from(licenses)
        .innerJoin(tenants, eq(licenses.tenantId, tenants.id))
        .where(eq(licenses.key, key))
      if (!row || row.license.buyerEmail.toLowerCase() !== email.toLowerCase()) {
        return c.json({ error: 'not found' }, 404)
      }
      stripeCustomerId = row.license.stripeCustomerId
      tenant = row.tenant
    }

    if (!tenant) return c.json({ error: 'not found' }, 404)

    if (stripeCustomerId) {
      const cred = await loadStripeCredential(c.env, db, tenant)
      const stripeAuth = resolveStripeAuth(c.env, cred)
      if (stripeAuth) {
        try {
          const portal = await createStripeBillingPortalSession(stripeAuth, {
            customerId: stripeCustomerId,
            returnUrl: `${c.env.PORTAL_URL}/portal`,
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
      }
    }

    if (tenant.settings.billingPortalUrl) {
      return c.json({ url: tenant.settings.billingPortalUrl })
    }
    return c.json({ error: 'no billing portal available for this purchase' }, 404)
  },
)

async function setSubscriptionCancelAtPeriodEnd(c: Context<AppEnv>, cancelAtPeriodEnd: boolean) {
  const db = c.get('db')
  const email = await signedInEmail(c)
  if (!email) return c.json({ error: 'unauthorized' }, 401)

  const id = c.req.param('id')
  if (!id) return c.json({ error: 'not found' }, 404)
  const [row] = await db
    .select({ subscription: subscriptions, tenant: tenants })
    .from(subscriptions)
    .innerJoin(tenants, eq(subscriptions.tenantId, tenants.id))
    .where(eq(subscriptions.id, id))
  if (!row || row.subscription.buyerEmail.toLowerCase() !== email.toLowerCase()) {
    return c.json({ error: 'not found' }, 404)
  }

  const sub = row.subscription
  if (sub.status !== 'active' && sub.status !== 'trialing' && sub.status !== 'past_due') {
    return c.json({ error: `cannot modify a ${sub.status} subscription` }, 400)
  }
  if (!sub.stripeSubscriptionId) {
    return c.json({ error: 'subscription cannot be managed via Stripe' }, 400)
  }

  const cred = await loadStripeCredential(c.env, db, row.tenant)
  const stripeAuth = resolveStripeAuth(c.env, cred)
  if (!stripeAuth) {
    return c.json({ error: 'Stripe is not connected for this extension' }, 400)
  }

  try {
    const apiBase = resolveStripeApiBase(c.env)
    // Canceling a subscription supersedes any pending scheduled plan change.
    if (cancelAtPeriodEnd && sub.stripeScheduleId) {
      await releaseStripeSubscriptionSchedule(stripeAuth, {
        scheduleId: sub.stripeScheduleId,
        apiBase,
      })
    }
    const updated = await updateStripeSubscription(stripeAuth, {
      subscriptionId: sub.stripeSubscriptionId,
      cancelAtPeriodEnd,
      apiBase,
    })
    await db
      .update(subscriptions)
      .set({
        cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
        ...(cancelAtPeriodEnd ? { pendingPlanId: null, pendingEffectiveAt: null, stripeScheduleId: null } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(subscriptions.id, sub.id))
    await db.insert(subscriptionEvents).values({
      id: newId('subscriptionEvent'),
      tenantId: sub.tenantId,
      subscriptionId: sub.id,
      type: updated.cancelAtPeriodEnd ? 'canceled' : 'updated',
      payload: { source: 'buyer_portal', cancelAtPeriodEnd: updated.cancelAtPeriodEnd },
    })
    return c.json({
      subscription: {
        id: sub.id,
        status: sub.status,
        cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
        currentPeriodEnd: sub.currentPeriodEnd,
        ...(cancelAtPeriodEnd ? { pendingPlan: null } : {}),
      },
    })
  } catch (err) {
    if (err instanceof StripeApiError) {
      const mapped = stripeErrorToHttp(err)
      return c.json(mapped.body, mapped.status)
    }
    throw err
  }
}

const changePlanBodySchema = v.object({
  planId: v.pipe(v.string('planId is required'), v.trim(), v.minLength(1, 'planId is required')),
})

route.post(
  '/subscriptions/:id/change-plan',
  describeRoute({
    summary: 'Schedule an end-of-period subscription plan change via Stripe Subscription Schedules',
    tags: ['Buyer portal'],
    security: [{ buyerSession: [] }],
    responses: {
      200: { description: 'Plan change scheduled (or reverted to current plan)' },
      400: { description: 'Invalid target plan, subscription state, or Stripe not connected' },
      401: { description: 'No buyer session' },
      404: { description: 'Subscription or target plan not found' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  validator('json', changePlanBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const email = await signedInEmail(c)
    if (!email) return c.json({ error: 'unauthorized' }, 401)

    const id = c.req.param('id')
    const [row] = await db
      .select({ subscription: subscriptions, currentPlan: plans, tenant: tenants })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .innerJoin(tenants, eq(subscriptions.tenantId, tenants.id))
      .where(eq(subscriptions.id, id))
    if (!row || row.subscription.buyerEmail.toLowerCase() !== email.toLowerCase()) {
      return c.json({ error: 'not found' }, 404)
    }

    const { subscription: sub, currentPlan, tenant } = row
    if (sub.status !== 'active' && sub.status !== 'trialing') {
      return c.json({ error: `cannot change plan for a ${sub.status} subscription` }, 400)
    }
    if (!sub.stripeSubscriptionId) {
      return c.json({ error: 'subscription cannot be managed via Stripe' }, 400)
    }

    const cred = await loadStripeCredential(c.env, db, tenant)
    const stripeAuth = resolveStripeAuth(c.env, cred)
    if (!stripeAuth) {
      return c.json({ error: 'Stripe is not connected for this extension' }, 400)
    }

    const { planId: targetPlanId } = c.req.valid('json')
    const [targetPlan] = await db
      .select()
      .from(plans)
      .where(and(eq(plans.id, targetPlanId), eq(plans.extensionId, sub.extensionId)))
    if (!targetPlan) return c.json({ error: 'target plan not found' }, 404)
    if (targetPlan.entitlementType !== 'recurring') {
      return c.json({ error: 'target plan must be a recurring subscription plan' }, 400)
    }
    if (!targetPlan.stripePriceId) {
      return c.json({ error: 'target plan has no Stripe price configured' }, 400)
    }
    if (targetPlan.currency.toLowerCase() !== currentPlan.currency.toLowerCase()) {
      return c.json({ error: 'cannot switch between plans with different currencies' }, 400)
    }

    const apiBase = resolveStripeApiBase(c.env)

    // Switching back to the current plan cancels any pending scheduled change.
    if (targetPlan.id === sub.planId) {
      if (!sub.pendingPlanId && !sub.stripeScheduleId) {
        return c.json({ error: 'subscription is already on this plan' }, 400)
      }
      try {
        if (sub.stripeScheduleId) {
          await releaseStripeSubscriptionSchedule(stripeAuth, { scheduleId: sub.stripeScheduleId, apiBase })
        }
        await db
          .update(subscriptions)
          .set({
            pendingPlanId: null,
            pendingEffectiveAt: null,
            stripeScheduleId: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(subscriptions.id, sub.id))
        await db.insert(subscriptionEvents).values({
          id: newId('subscriptionEvent'),
          tenantId: sub.tenantId,
          subscriptionId: sub.id,
          type: 'updated',
          payload: { source: 'buyer_portal', action: 'plan_change_canceled' },
        })
        return c.json({
          subscription: {
            id: sub.id,
            planId: sub.planId,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            pendingPlan: null,
          },
        })
      } catch (err) {
        if (err instanceof StripeApiError) {
          const mapped = stripeErrorToHttp(err)
          return c.json(mapped.body, mapped.status)
        }
        throw err
      }
    }

    try {
      const scheduled = await scheduleStripeSubscriptionPlanChange(stripeAuth, {
        subscriptionId: sub.stripeSubscriptionId,
        targetPriceId: targetPlan.stripePriceId,
        targetPlanId: targetPlan.id,
        existingScheduleId: sub.stripeScheduleId,
        apiBase,
      })
      await db
        .update(subscriptions)
        .set({
          pendingPlanId: targetPlan.id,
          pendingEffectiveAt: scheduled.effectiveAt,
          stripeScheduleId: scheduled.scheduleId,
          cancelAtPeriodEnd: false,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(subscriptions.id, sub.id))
      await db.insert(subscriptionEvents).values({
        id: newId('subscriptionEvent'),
        tenantId: sub.tenantId,
        subscriptionId: sub.id,
        type: 'updated',
        payload: {
          source: 'buyer_portal',
          action: 'plan_change_scheduled',
          fromPlanId: sub.planId,
          toPlanId: targetPlan.id,
          effectiveAt: scheduled.effectiveAt,
          stripeScheduleId: scheduled.scheduleId,
        },
      })
      return c.json({
        subscription: {
          id: sub.id,
          planId: sub.planId,
          cancelAtPeriodEnd: false,
          pendingPlan: {
            id: targetPlan.id,
            tier: targetPlan.tier,
            billingInterval: targetPlan.billingInterval,
            amount: targetPlan.amount,
            currency: targetPlan.currency,
            effectiveAt: scheduled.effectiveAt,
          },
        },
      })
    } catch (err) {
      if (err instanceof StripeApiError) {
        const mapped = stripeErrorToHttp(err)
        return c.json(mapped.body, mapped.status)
      }
      throw err
    }
  },
)

route.delete(
  '/subscriptions/:id/scheduled-change',
  describeRoute({
    summary: 'Cancel a pending end-of-period subscription plan change',
    tags: ['Buyer portal'],
    security: [{ buyerSession: [] }],
    responses: {
      200: { description: 'Scheduled plan change canceled' },
      400: { description: 'Stripe not connected' },
      401: { description: 'No buyer session' },
      404: { description: 'Subscription not found' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  async (c) => {
    const db = c.get('db')
    const email = await signedInEmail(c)
    if (!email) return c.json({ error: 'unauthorized' }, 401)

    const id = c.req.param('id')
    const [row] = await db
      .select({ subscription: subscriptions, tenant: tenants })
      .from(subscriptions)
      .innerJoin(tenants, eq(subscriptions.tenantId, tenants.id))
      .where(eq(subscriptions.id, id))
    if (!row || row.subscription.buyerEmail.toLowerCase() !== email.toLowerCase()) {
      return c.json({ error: 'not found' }, 404)
    }

    const sub = row.subscription
    if (!sub.pendingPlanId && !sub.stripeScheduleId) {
      return c.json({ subscription: { id: sub.id, planId: sub.planId, pendingPlan: null } })
    }

    const cred = await loadStripeCredential(c.env, db, row.tenant)
    const stripeAuth = resolveStripeAuth(c.env, cred)
    if (!stripeAuth) {
      return c.json({ error: 'Stripe is not connected for this extension' }, 400)
    }

    try {
      if (sub.stripeScheduleId) {
        await releaseStripeSubscriptionSchedule(stripeAuth, {
          scheduleId: sub.stripeScheduleId,
          apiBase: resolveStripeApiBase(c.env),
        })
      }
      await db
        .update(subscriptions)
        .set({
          pendingPlanId: null,
          pendingEffectiveAt: null,
          stripeScheduleId: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(subscriptions.id, sub.id))
      await db.insert(subscriptionEvents).values({
        id: newId('subscriptionEvent'),
        tenantId: sub.tenantId,
        subscriptionId: sub.id,
        type: 'updated',
        payload: { source: 'buyer_portal', action: 'plan_change_canceled' },
      })
      return c.json({ subscription: { id: sub.id, planId: sub.planId, pendingPlan: null } })
    } catch (err) {
      if (err instanceof StripeApiError) {
        const mapped = stripeErrorToHttp(err)
        return c.json(mapped.body, mapped.status)
      }
      throw err
    }
  },
)

route.post(
  '/subscriptions/:id/cancel',
  describeRoute({
    summary: 'Cancel a subscription at the end of the current billing period',
    tags: ['Buyer portal'],
    security: [{ buyerSession: [] }],
    responses: {
      200: { description: 'Scheduled for cancellation at period end' },
      400: { description: 'Subscription cannot be canceled or missing Restricted Key' },
      401: { description: 'No buyer session' },
      404: { description: 'Subscription not found' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  (c) => setSubscriptionCancelAtPeriodEnd(c, true),
)

route.post(
  '/subscriptions/:id/resume',
  describeRoute({
    summary: 'Resume a subscription scheduled for cancellation at period end',
    tags: ['Buyer portal'],
    security: [{ buyerSession: [] }],
    responses: {
      200: { description: 'Subscription resumed' },
      400: { description: 'Subscription cannot be resumed or missing Restricted Key' },
      401: { description: 'No buyer session' },
      404: { description: 'Subscription not found' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  (c) => setSubscriptionCancelAtPeriodEnd(c, false),
)

route.get(
  '/subscriptions/:id/invoices',
  describeRoute({
    summary: 'List Stripe invoices for a buyer subscription',
    tags: ['Buyer portal'],
    security: [{ buyerSession: [] }],
    responses: {
      200: { description: 'Invoice list' },
      400: { description: 'Missing Stripe Restricted Key or subscription reference' },
      401: { description: 'No buyer session' },
      404: { description: 'Subscription not found' },
      502: { description: 'Stripe API unavailable' },
    },
  }),
  async (c) => {
    const db = c.get('db')
    const email = await signedInEmail(c)
    if (!email) return c.json({ error: 'unauthorized' }, 401)

    const id = c.req.param('id')
    const [row] = await db
      .select({ subscription: subscriptions, tenant: tenants })
      .from(subscriptions)
      .innerJoin(tenants, eq(subscriptions.tenantId, tenants.id))
      .where(eq(subscriptions.id, id))
    if (!row || row.subscription.buyerEmail.toLowerCase() !== email.toLowerCase()) {
      return c.json({ error: 'not found' }, 404)
    }

    const sub = row.subscription
    if (!sub.stripeSubscriptionId && !sub.stripeCustomerId) {
      return c.json({ invoices: [] })
    }

    const cred = await loadStripeCredential(c.env, db, row.tenant)
    const stripeAuth = resolveStripeAuth(c.env, cred)
    if (!stripeAuth) {
      return c.json({ error: 'Stripe is not connected for this extension' }, 400)
    }

    try {
      const invoices = await listStripeInvoices(stripeAuth, {
        subscriptionId: sub.stripeSubscriptionId,
        customerId: sub.stripeCustomerId,
        apiBase: resolveStripeApiBase(c.env),
      })
      return c.json({ invoices })
    } catch (err) {
      if (err instanceof StripeApiError) {
        const mapped = stripeErrorToHttp(err)
        return c.json(mapped.body, mapped.status)
      }
      throw err
    }
  },
)

route.get('/dev-login', async (c) => {
  if (!c.env.DEV_LOGIN_ENABLED) return c.notFound()
  const email = c.req.query('email')?.trim()
  if (!email) return c.json({ error: 'email query parameter is required' }, 400)
  const db = c.get('db')
  const link = await createMagicLink(db, email)
  const session = await consumeMagicLink(db, link.code)
  if (!session) return c.json({ error: 'failed to create buyer session' }, 500)
  setCookie(c, BUYER_SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    expires: new Date(session.expiresAt),
  })
  return c.redirect('/portal', 302)
})

route.post(
  '/logout',
  describeRoute({
    summary: 'Sign out of the buyer portal',
    tags: ['Buyer portal'],
    security: [{ buyerSession: [] }],
    responses: { 200: { description: 'OK' } },
  }),
  async (c) => {
    const token = getCookie(c, BUYER_SESSION_COOKIE)
    if (token) await destroyBuyerSession(c.get('db'), token)
    deleteCookie(c, BUYER_SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  },
)

export default route
