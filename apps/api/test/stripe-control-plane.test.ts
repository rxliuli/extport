import { newId } from '@extport/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { licenses, subscriptions, type License, type Plan, type Subscription } from '../src/db'
import { BUYER_SESSION_COOKIE, consumeMagicLink, createMagicLink } from '../src/lib/buyer-session'
import { createApiKey, createExtension, request, seedTenantWithUser } from './helpers'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

type StripeHandler = (url: string, params: URLSearchParams) => { status?: number; body: unknown }

function mockStripeFetch(handler: StripeHandler) {
  const calls: { url: string; params: URLSearchParams; auth: string | null }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('https://api.stripe.com/v1/')) {
      throw new Error(`Unexpected outbound fetch: ${url}`)
    }
    const headers = new Headers(init?.headers)
    const params = new URLSearchParams(String(init?.body ?? ''))
    calls.push({ url, params, auth: headers.get('authorization') })
    const res = handler(url.slice('https://api.stripe.com/v1'.length), params)
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return calls
}

async function setupControlPlaneTenant(opts: { apiKey?: string } = {}) {
  const seeded = await seedTenantWithUser()
  const { sessionCookie } = seeded
  const apiKey = await createApiKey(sessionCookie)
  const extension = await createExtension(sessionCookie, 'Control Plane Ext')
  await request(`/api/v1/extensions/${extension.id}`, {
    method: 'PATCH',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ licensingEnabled: true }),
  })
  if (opts.apiKey !== undefined) {
    const credRes = await request('/api/v1/payment-credentials', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'stripe', apiKey: opts.apiKey }),
    })
    expect(credRes.status).toBe(200)
  }
  return { ...seeded, apiKey, extension }
}

let subSeq = 0
async function seedSubscription(
  db: Awaited<ReturnType<typeof seedTenantWithUser>>['db'],
  values: {
    tenantId: string
    extensionId: string
    planId: string
    buyerEmail: string
    externalUserId?: string | null
    stripeCustomerId?: string | null
    checkoutSessionId?: string | null
    status?: Subscription['status']
    currentPeriodStart?: string | null
    currentPeriodEnd?: string | null
    cancelAtPeriodEnd?: boolean
    amountTotal?: number | null
    currency?: string | null
    createdAt?: string
  },
): Promise<Subscription> {
  subSeq += 1
  const id = newId('subscription')
  await db.insert(subscriptions).values({
    id,
    tenantId: values.tenantId,
    extensionId: values.extensionId,
    planId: values.planId,
    buyerEmail: values.buyerEmail,
    externalUserId: values.externalUserId ?? null,
    stripeCustomerId: values.stripeCustomerId ?? null,
    stripeSubscriptionId: `sub_seed_${subSeq}`,
    checkoutSessionId: values.checkoutSessionId ?? `cs_seed_${subSeq}`,
    status: values.status ?? 'active',
    currentPeriodStart: values.currentPeriodStart ?? null,
    currentPeriodEnd: values.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: values.cancelAtPeriodEnd ?? false,
    amountTotal: values.amountTotal ?? 499,
    currency: values.currency ?? 'usd',
    ...(values.createdAt ? { createdAt: values.createdAt } : {}),
  })
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id))
  return row!
}

describe('plans auto-sync with Stripe', () => {
  it('requires a Stripe Restricted Key when amounts are provided without manual price IDs', async () => {
    const { sessionCookie, extension } = await setupControlPlaneTenant()

    const res = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ extensionId: extension.id, tier: 'pro', amount: 1999 }),
    })
    expect(res.status).toBe(400)

    // Manual priceId without apiKey succeeds for linking existing Stripe prices.
    const manual = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        amount: 1999,
        stripeProductId: 'prod_manual',
        stripePriceId: 'price_manual',
      }),
    })
    expect(manual.status).toBe(201)
    const { plan } = (await manual.json()) as { plan: Plan }
    expect(plan.stripeProductId).toBe('prod_manual')
    expect(plan.stripePriceId).toBe('price_manual')
    expect(plan.currency).toBe('usd')
    expect(plan.maxActivations).toBe(3)
  })

  it('rejects mismatched billingInterval between perpetual and recurring plans', async () => {
    const { sessionCookie, extension } = await setupControlPlaneTenant({ apiKey: 'rk_test_plan_mismatch' })

    const perpWithMonth = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'perpetual',
        billingInterval: 'month',
        amount: 499,
      }),
    })
    expect(perpWithMonth.status).toBe(400)

    const recWithOneTime = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'recurring',
        billingInterval: 'one_time',
        amount: 1999,
      }),
    })
    expect(recWithOneTime.status).toBe(400)
  })

  it('creates Stripe Product + Price on POST (maxActivations=0 for recurring), allows monthly + yearly rows per tier, and archives old Price on PATCH', async () => {
    const { sessionCookie, extension } = await setupControlPlaneTenant({ apiKey: 'rk_test_plan_sync_secret' })

    let priceSeq = 0
    const calls = mockStripeFetch((path, params) => {
      if (path === '/products') {
        expect(params.get('name')).toBe('Control Plane Ext')
        return { body: { id: 'prod_auto_1' } }
      }
      if (path === '/prices') {
        priceSeq += 1
        return { body: { id: `price_auto_${priceSeq}` } }
      }
      if (path.startsWith('/prices/price_auto_')) {
        if (path === '/prices/price_auto_1') {
          return { status: 400, body: { error: { message: 'Already archived' } } }
        }
        return { body: { id: path.split('/').pop(), active: false } }
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    const createMonthlyRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'recurring',
        billingInterval: 'month',
        currency: 'EUR',
        amount: 499,
      }),
    })
    expect(createMonthlyRes.status).toBe(201)
    const { plan: monthlyPlan } = (await createMonthlyRes.json()) as { plan: Plan }
    expect(monthlyPlan.maxActivations).toBe(0)
    expect(monthlyPlan.billingInterval).toBe('month')
    expect(monthlyPlan.currency).toBe('eur')
    expect(monthlyPlan.amount).toBe(499)
    expect(monthlyPlan.stripeProductId).toBe('prod_auto_1')
    expect(monthlyPlan.stripePriceId).toBe('price_auto_1')
    expect(calls[0]!.params.get('metadata[extport_extension]')).toBe(monthlyPlan.extensionId)
    expect(calls[1]!.params.get('metadata[extport_plan]')).toBe(monthlyPlan.id)
    expect(calls[1]!.params.get('currency')).toBe('eur')
    expect(calls[1]!.params.get('recurring[interval]')).toBe('month')

    // Adding a yearly plan for the same tier reuses prod_auto_1 and creates a second Stripe Price.
    const createYearlyRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'recurring',
        billingInterval: 'year',
        currency: 'EUR',
        amount: 4999,
      }),
    })
    expect(createYearlyRes.status).toBe(201)
    const { plan: yearlyPlan } = (await createYearlyRes.json()) as { plan: Plan }
    expect(yearlyPlan.billingInterval).toBe('year')
    expect(yearlyPlan.stripeProductId).toBe('prod_auto_1')
    expect(yearlyPlan.stripePriceId).toBe('price_auto_2')
    expect(calls[2]!.params.get('recurring[interval]')).toBe('year')

    // Updating amount without maxActivations succeeds, creates a new monthly price, and archives price_auto_1.
    const patchRes = await request(`/api/v1/plans/${monthlyPlan.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 699 }),
    })
    expect(patchRes.status).toBe(200)
    const { plan: updated } = (await patchRes.json()) as { plan: Plan }
    expect(updated.amount).toBe(699)
    expect(updated.stripePriceId).toBe('price_auto_3')
    const archiveCall = calls[calls.length - 1]!
    expect(archiveCall.url).toBe('https://api.stripe.com/v1/prices/price_auto_1')
    expect(archiveCall.params.get('active')).toBe('false')
  })

  it('forwards Stripe API errors without leaking the tenant Restricted Key', async () => {
    const secretKey = 'rk_test_never_leak_this_key'
    const { sessionCookie, extension } = await setupControlPlaneTenant({ apiKey: secretKey })
    mockStripeFetch(() => ({
      status: 403,
      body: { error: { code: 'permission_error', message: 'Restricted key lacks write access to Products' } },
    }))

    const res = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ extensionId: extension.id, tier: 'pro', amount: 999 }),
    })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain('Restricted key lacks write access to Products')
    expect(text).not.toContain(secretKey)
  })

  it('preserves manually-linked stripePriceId when patching maxActivations, and archives/clears when amount is explicitly nulled', async () => {
    const { sessionCookie, extension } = await setupControlPlaneTenant({ apiKey: 'rk_test_preserve_price' })
    const calls = mockStripeFetch((path) => {
      if (path === '/prices/price_manual_keep') return { body: { id: 'price_manual_keep', active: false } }
      throw new Error(`Unexpected path: ${path}`)
    })

    const createRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'perpetual',
        stripeProductId: 'prod_manual_keep',
        stripePriceId: 'price_manual_keep',
      }),
    })
    expect(createRes.status).toBe(201)
    const { plan } = (await createRes.json()) as { plan: Plan }

    const maxRes = await request(`/api/v1/plans/${plan.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ maxActivations: 8 }),
    })
    expect(maxRes.status).toBe(200)
    const { plan: afterMax } = (await maxRes.json()) as { plan: Plan }
    expect(afterMax.maxActivations).toBe(8)
    expect(afterMax.stripePriceId).toBe('price_manual_keep')
    expect(calls).toHaveLength(0)

    const clearRes = await request(`/api/v1/plans/${plan.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: null }),
    })
    expect(clearRes.status).toBe(200)
    const { plan: afterClear } = (await clearRes.json()) as { plan: Plan }
    expect(afterClear.amount).toBeNull()
    expect(afterClear.stripePriceId).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/prices/price_manual_keep')
  })
})

describe('POST /api/v1/licensing/checkout (perpetual one-time licenses)', () => {
  it('creates one-time payment Checkout Sessions and reuses stripeCustomerId from prior licenses', async () => {
    const { db, sessionCookie, apiKey, extension } = await setupControlPlaneTenant({
      apiKey: 'rk_test_perp_checkout',
    })
    const otherExtension = await createExtension(sessionCookie, 'Sibling Ext')

    let priceSeq = 0
    let sessionSeq = 0
    const calls = mockStripeFetch((path) => {
      if (path === '/products') return { body: { id: 'prod_perp_1' } }
      if (path === '/prices') return { body: { id: `price_perp_${++priceSeq}` } }
      if (path === '/checkout/sessions') {
        sessionSeq += 1
        return {
          body: { id: `cs_perp_${sessionSeq}`, url: `https://checkout.stripe.com/c/pay/cs_perp_${sessionSeq}` },
        }
      }
      throw new Error(`Unexpected Stripe path: ${path}`)
    })

    const perpRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ extensionId: extension.id, tier: 'pro', entitlementType: 'perpetual', amount: 1999 }),
    })
    const { plan: perpPlan } = (await perpRes.json()) as { plan: Plan }

    const sibRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ extensionId: otherExtension.id, tier: 'pro', entitlementType: 'perpetual', amount: 999 }),
    })
    const { plan: sibPlan } = (await sibRes.json()) as { plan: Plan }

    // Give user_42 an issued license on sibling extension with a stripeCustomerId -> checkout reuses it!
    const sibLicRes = await request('/api/v1/licenses', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ planId: sibPlan.id, buyerEmail: 'buyer@example.com', externalUserId: 'user_42' }),
    })
    const { license: sibLic } = (await sibLicRes.json()) as { license: License }
    await db.update(licenses).set({ stripeCustomerId: 'cus_reused_42' }).where(eq(licenses.id, sibLic.id))

    const chkOneTime = await request('/api/v1/licensing/checkout', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        externalUserId: 'user_42',
        email: 'buyer@example.com',
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/cancel',
      }),
    })
    expect(chkOneTime.status).toBe(200)
    expect(await chkOneTime.json()).toEqual({
      action: 'checkout',
      url: 'https://checkout.stripe.com/c/pay/cs_perp_1',
      sessionId: 'cs_perp_1',
    })
    const stripeCall = calls[calls.length - 1]!
    expect(stripeCall.params.get('mode')).toBe('payment')
    expect(stripeCall.params.get('line_items[0][price]')).toBe(perpPlan.stripePriceId)
    expect(stripeCall.params.get('customer')).toBe('cus_reused_42')
    expect(stripeCall.params.get('customer_email')).toBeNull()
  })
})

describe('/api/v1/subscriptions — list, entitlements, checkout guard, and portal', () => {
  it('validates inputs, resolves recurring plan/interval, reuses customerId across extensions, and creates Checkout Sessions', async () => {
    const { db, tenantId, sessionCookie, apiKey, extension } = await setupControlPlaneTenant({
      apiKey: 'rk_test_sub_checkout',
    })
    const otherExtension = await createExtension(sessionCookie, 'Sibling Sub Ext')

    let priceSeq = 0
    let sessionSeq = 0
    const calls = mockStripeFetch((path) => {
      if (path === '/products') return { body: { id: 'prod_sub_1' } }
      if (path === '/prices') return { body: { id: `price_sub_${++priceSeq}` } }
      if (path === '/checkout/sessions') {
        sessionSeq += 1
        return {
          body: { id: `cs_sub_${sessionSeq}`, url: `https://checkout.stripe.com/c/pay/cs_sub_${sessionSeq}` },
        }
      }
      throw new Error(`Unexpected Stripe path: ${path}`)
    })

    const recMonthlyRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'recurring',
        billingInterval: 'month',
        amount: 499,
      }),
    })
    const { plan: recMonthlyPlan } = (await recMonthlyRes.json()) as { plan: Plan }

    const recYearlyRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'recurring',
        billingInterval: 'year',
        amount: 4999,
      }),
    })
    const { plan: recYearlyPlan } = (await recYearlyRes.json()) as { plan: Plan }

    const sibPlanRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: otherExtension.id,
        tier: 'pro',
        entitlementType: 'recurring',
        billingInterval: 'month',
        amount: 399,
      }),
    })
    const { plan: sibPlan } = (await sibPlanRes.json()) as { plan: Plan }

    // Unauthenticated -> 401.
    expect(
      (
        await request('/api/v1/subscriptions/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            extensionId: extension.id,
            successUrl: 'https://example.com/ok',
            cancelUrl: 'https://example.com/cancel',
          }),
        })
      ).status,
    ).toBe(401)

    // Omitting interval when both monthly & yearly exist -> 400.
    expect(
      (
        await request('/api/v1/subscriptions/checkout', {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            extensionId: extension.id,
            successUrl: 'https://example.com/ok',
            cancelUrl: 'https://example.com/cancel',
          }),
        })
      ).status,
    ).toBe(400)

    // Invalid redirect URL -> 400.
    expect(
      (
        await request('/api/v1/subscriptions/checkout', {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            extensionId: extension.id,
            interval: 'monthly',
            successUrl: 'javascript:alert(1)',
            cancelUrl: 'https://example.com/cancel',
          }),
        })
      ).status,
    ).toBe(400)

    // Create checkout for monthly subscription.
    const chkMonthly = await request('/api/v1/subscriptions/checkout', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        interval: 'monthly',
        externalUserId: 'user_42',
        email: 'Buyer@Example.com',
        successUrl: 'https://app.example.com/account?upgraded=1',
        cancelUrl: 'https://app.example.com/pricing',
      }),
    })
    expect(chkMonthly.status).toBe(200)
    expect(await chkMonthly.json()).toEqual({
      action: 'checkout',
      url: 'https://checkout.stripe.com/c/pay/cs_sub_1',
      sessionId: 'cs_sub_1',
    })
    const stripeCall1 = calls[calls.length - 1]!
    expect(stripeCall1.params.get('mode')).toBe('subscription')
    expect(stripeCall1.params.get('line_items[0][price]')).toBe(recMonthlyPlan.stripePriceId)
    expect(stripeCall1.params.get('metadata[extport_plan]')).toBe(recMonthlyPlan.id)
    expect(stripeCall1.params.get('subscription_data[metadata][extport_plan]')).toBe(recMonthlyPlan.id)
    expect(stripeCall1.params.get('client_reference_id')).toBe('user_42')
    expect(stripeCall1.params.get('customer_email')).toBe('Buyer@Example.com')

    // Prior subscription on sibling extension with stripeCustomerId -> reused on checkout for main extension!
    await seedSubscription(db, {
      tenantId,
      extensionId: otherExtension.id,
      planId: sibPlan.id,
      buyerEmail: 'buyer@example.com',
      externalUserId: 'user_42',
      stripeCustomerId: 'cus_sib_42',
    })

    const chkYearly = await request('/api/v1/subscriptions/checkout', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        interval: 'yearly',
        externalUserId: 'user_42',
        email: 'buyer@example.com',
        successUrl: 'https://app.example.com/account',
        cancelUrl: 'https://app.example.com/pricing',
      }),
    })
    expect(chkYearly.status).toBe(200)
    const stripeCall2 = calls[calls.length - 1]!
    expect(stripeCall2.params.get('line_items[0][price]')).toBe(recYearlyPlan.stripePriceId)
    expect(stripeCall2.params.get('customer')).toBe('cus_sib_42')
    expect(stripeCall2.params.get('customer_email')).toBeNull()
  })

  it('guards duplicate subscriptions: returns Billing Portal, 409 when no customerId, and allows re-checkout after expiry', async () => {
    const { db, tenantId, sessionCookie, apiKey, extension } = await setupControlPlaneTenant({
      apiKey: 'rk_test_dup_guard',
    })
    const calls = mockStripeFetch((path) => {
      if (path === '/products') return { body: { id: 'prod_dg' } }
      if (path === '/prices') return { body: { id: `price_dg_${Math.random().toString(36).slice(2, 7)}` } }
      if (path === '/billing_portal/sessions') {
        return { body: { id: 'bps_dg_1', url: 'https://billing.stripe.com/p/session/bps_dg_1' } }
      }
      if (path === '/checkout/sessions') {
        return { body: { id: 'cs_dg_new', url: 'https://checkout.stripe.com/c/pay/cs_dg_new' } }
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    const planRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'recurring',
        billingInterval: 'month',
        amount: 499,
      }),
    })
    const { plan } = (await planRes.json()) as { plan: Plan }

    const sub = await seedSubscription(db, {
      tenantId,
      extensionId: extension.id,
      planId: plan.id,
      buyerEmail: 'SubUser@Example.com',
      externalUserId: 'ext_sub_1',
      stripeCustomerId: null,
      status: 'active',
    })

    const attemptCheckout = (payload: Record<string, unknown>) =>
      request('/api/v1/subscriptions/checkout', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          extensionId: extension.id,
          planId: plan.id,
          successUrl: 'https://example.com/ok',
          cancelUrl: 'https://example.com/pricing',
          ...payload,
        }),
      })

    // 1. Active subscription without stripeCustomerId -> 409!
    expect((await attemptCheckout({ externalUserId: 'ext_sub_1' })).status).toBe(409)
    // Also matched by case-insensitive email alone.
    expect((await attemptCheckout({ email: 'subuser@example.com' })).status).toBe(409)

    // 2. With stripeCustomerId -> creates one-click Billing Portal session with returnUrl = cancelUrl.
    await db.update(subscriptions).set({ stripeCustomerId: 'cus_sub_1' }).where(eq(subscriptions.id, sub.id))
    const oneClickPortal = await attemptCheckout({ externalUserId: 'ext_sub_1' })
    expect(oneClickPortal.status).toBe(200)
    expect(await oneClickPortal.json()).toEqual({
      action: 'portal',
      url: 'https://billing.stripe.com/p/session/bps_dg_1',
      reason: 'already_subscribed',
    })
    const portalCall = calls[calls.length - 1]!
    expect(portalCall.url).toBe('https://api.stripe.com/v1/billing_portal/sessions')
    expect(portalCall.params.get('customer')).toBe('cus_sub_1')
    expect(portalCall.params.get('return_url')).toBe('https://example.com/pricing')

    // 3. Duplicate guard also blocks trialing, past_due, and canceled-in-period subscriptions.
    for (const patch of [
      { status: 'trialing' as const, currentPeriodEnd: null },
      { status: 'past_due' as const, currentPeriodEnd: null },
      { status: 'canceled' as const, currentPeriodEnd: new Date(Date.now() + 86400_000).toISOString() },
    ]) {
      await db.update(subscriptions).set(patch).where(eq(subscriptions.id, sub.id))
      const guarded = await attemptCheckout({ externalUserId: 'ext_sub_1' })
      expect(guarded.status).toBe(200)
      expect(((await guarded.json()) as { action: string; reason: string }).reason).toBe('already_subscribed')
    }

    // 4. Once expired, user IS allowed to start a new checkout (reusing cus_sub_1).
    await db.update(subscriptions).set({ status: 'expired' }).where(eq(subscriptions.id, sub.id))
    const reCheckout = await attemptCheckout({ externalUserId: 'ext_sub_1' })
    expect(reCheckout.status).toBe(200)
    expect(await reCheckout.json()).toEqual({
      action: 'checkout',
      url: 'https://checkout.stripe.com/c/pay/cs_dg_new',
      sessionId: 'cs_dg_new',
    })
    const checkoutCall = calls[calls.length - 1]!
    expect(checkoutCall.params.get('customer')).toBe('cus_sub_1')
  })

  it('POST /api/v1/subscriptions/portal picks best matching customer and enforces tenant isolation', async () => {
    const a = await setupControlPlaneTenant({ apiKey: 'rk_test_portal_a' })
    const b = await setupControlPlaneTenant({ apiKey: 'rk_test_portal_b' })
    const calls = mockStripeFetch((path) => {
      if (path === '/billing_portal/sessions') {
        return { body: { id: 'bps_p_1', url: 'https://billing.stripe.com/p/session/bps_p_1' } }
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    const planRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: a.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ extensionId: a.extension.id, tier: 'pro', entitlementType: 'recurring' }),
    })
    const { plan } = (await planRes.json()) as { plan: Plan }

    await seedSubscription(a.db, {
      tenantId: a.tenantId,
      extensionId: a.extension.id,
      planId: plan.id,
      buyerEmail: 'P@Example.com',
      externalUserId: 'u_portal',
      stripeCustomerId: 'cus_old',
      status: 'expired',
    })
    const activeSub = await seedSubscription(a.db, {
      tenantId: a.tenantId,
      extensionId: a.extension.id,
      planId: plan.id,
      buyerEmail: 'P@Example.com',
      externalUserId: 'u_portal',
      stripeCustomerId: null,
      status: 'active',
    })

    // Active sub has no cus_... yet -> picks cus_old; once active gets cus_active -> prefers cus_active.
    const resOld = await request('/api/v1/subscriptions/portal', {
      method: 'POST',
      headers: { authorization: `Bearer ${a.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: a.extension.id,
        externalUserId: 'u_portal',
        returnUrl: 'https://app.example.com/account',
      }),
    })
    expect(resOld.status).toBe(200)
    expect(calls[0]!.params.get('customer')).toBe('cus_old')

    await a.db.update(subscriptions).set({ stripeCustomerId: 'cus_active' }).where(eq(subscriptions.id, activeSub.id))
    const resActive = await request('/api/v1/subscriptions/portal', {
      method: 'POST',
      headers: { authorization: `Bearer ${a.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'p@example.com',
        returnUrl: 'https://app.example.com/account',
      }),
    })
    expect(resActive.status).toBe(200)
    expect(await resActive.json()).toEqual({ url: 'https://billing.stripe.com/p/session/bps_p_1' })
    expect(calls[1]!.params.get('customer')).toBe('cus_active')
    expect(calls[1]!.params.get('return_url')).toBe('https://app.example.com/account')

    // Missing identifier -> 400; unknown user -> 404; cross-tenant -> 404.
    expect(
      (
        await request('/api/v1/subscriptions/portal', {
          method: 'POST',
          headers: { authorization: `Bearer ${a.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ returnUrl: 'https://app.example.com/account' }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await request('/api/v1/subscriptions/portal', {
          method: 'POST',
          headers: { authorization: `Bearer ${a.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ externalUserId: 'nobody', returnUrl: 'https://app.example.com/account' }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await request('/api/v1/subscriptions/portal', {
          method: 'POST',
          headers: { authorization: `Bearer ${b.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            extensionId: a.extension.id,
            externalUserId: 'u_portal',
            returnUrl: 'https://app.example.com/account',
          }),
        })
      ).status,
    ).toBe(404)
  })

  it('GET /api/v1/subscriptions lists with filters & keyset pagination, and GET /entitlements picks best subscription', async () => {
    const { db, tenantId, sessionCookie, apiKey, extension } = await setupControlPlaneTenant()
    const planRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ extensionId: extension.id, tier: 'pro', entitlementType: 'recurring' }),
    })
    const { plan } = (await planRes.json()) as { plan: Plan }

    const t1 = '2026-10-01T00:00:00.000Z'
    const t2 = '2026-10-02T00:00:00.000Z'
    const t3 = '2026-10-03T00:00:00.000Z'
    const s1 = await seedSubscription(db, {
      tenantId,
      extensionId: extension.id,
      planId: plan.id,
      buyerEmail: 'Alice@Example.com',
      externalUserId: 'usr_alice',
      status: 'expired',
      createdAt: t1,
    })
    const s2 = await seedSubscription(db, {
      tenantId,
      extensionId: extension.id,
      planId: plan.id,
      buyerEmail: 'Alice@Example.com',
      externalUserId: 'usr_alice',
      status: 'active',
      currentPeriodStart: t2,
      currentPeriodEnd: '2026-12-01T00:00:00.000Z',
      createdAt: t2,
    })
    const s3 = await seedSubscription(db, {
      tenantId,
      extensionId: extension.id,
      planId: plan.id,
      buyerEmail: 'bob@example.com',
      externalUserId: 'usr_bob',
      status: 'trialing',
      createdAt: t3,
    })

    // Keyset pagination: limit=2 -> [s3, s2] + nextCursor -> [s1].
    const page1 = (await (
      await request(`/api/v1/subscriptions?extension=${extension.id}&limit=2`, {
        headers: { cookie: sessionCookie },
      })
    ).json()) as {
      subscriptions: (Subscription & { tier: string; extensionName: string })[]
      nextCursor: string | null
    }
    expect(page1.subscriptions.map((s) => s.id)).toEqual([s3.id, s2.id])
    expect(page1.subscriptions[0]!.tier).toBe('pro')
    expect(page1.subscriptions[0]!.extensionName).toBe('Control Plane Ext')
    expect(page1.nextCursor).not.toBeNull()

    const page2 = (await (
      await request(
        `/api/v1/subscriptions?extension=${extension.id}&limit=2&before=${encodeURIComponent(page1.nextCursor!)}`,
        { headers: { cookie: sessionCookie } },
      )
    ).json()) as { subscriptions: Subscription[]; nextCursor: string | null }
    expect(page2.subscriptions.map((s) => s.id)).toEqual([s1.id])
    expect(page2.nextCursor).toBeNull()

    // Status filter + search filter.
    const byStatus = (await (
      await request(`/api/v1/subscriptions?status=trialing`, { headers: { cookie: sessionCookie } })
    ).json()) as { subscriptions: Subscription[] }
    expect(byStatus.subscriptions.map((s) => s.id)).toEqual([s3.id])

    const bySearch = (await (
      await request(`/api/v1/subscriptions?search=usr_bob`, { headers: { cookie: sessionCookie } })
    ).json()) as { subscriptions: Subscription[] }
    expect(bySearch.subscriptions.map((s) => s.id)).toEqual([s3.id])

    // Entitlements picks active s2 over expired s1 for both externalUserId and case-insensitive email.
    const entRes = await request(
      `/api/v1/subscriptions/entitlements?extensionId=${extension.id}&email=alice@example.com`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    )
    expect(entRes.status).toBe(200)
    expect(entRes.headers.get('access-control-allow-origin')).toBeNull()
    expect(await entRes.json()).toEqual({
      active: true,
      tier: 'pro',
      subscriptionId: s2.id,
      status: 'active',
      currentPeriodStart: t2,
      currentPeriodEnd: '2026-12-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    })

    // Unknown user -> active: false, tier: 'free'.
    const missRes = await request(
      `/api/v1/subscriptions/entitlements?extensionId=${extension.id}&externalUserId=missing`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    )
    expect(await missRes.json()).toEqual({
      active: false,
      tier: 'free',
      subscriptionId: null,
      status: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    })

    // Extension deletion is blocked while subscriptions exist!
    const delBlocked = await request(`/api/v1/extensions/${extension.id}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie },
    })
    expect(delBlocked.status).toBe(409)
  })

  it('reuses one Stripe Product across multiple plans of the same extension', async () => {
    const { sessionCookie, extension } = await setupControlPlaneTenant({ apiKey: 'rk_test_reuse_prod_123456' })
    let priceCount = 0
    const calls = mockStripeFetch((path) => {
      if (path === '/products') return { body: { id: 'prod_shared_ext' } }
      if (path === '/prices') {
        priceCount += 1
        return { body: { id: `price_shared_${priceCount}` } }
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    const basicRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'basic',
        entitlementType: 'recurring',
        billingInterval: 'month',
        amount: 499,
      }),
    })
    expect(basicRes.status).toBe(201)
    const { plan: basicPlan } = (await basicRes.json()) as { plan: Plan }
    expect(basicPlan.stripeProductId).toBe('prod_shared_ext')

    const proRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'recurring',
        billingInterval: 'month',
        amount: 999,
      }),
    })
    expect(proRes.status).toBe(201)
    const { plan: proPlan } = (await proRes.json()) as { plan: Plan }
    expect(proPlan.stripeProductId).toBe('prod_shared_ext')

    // Only ONE Stripe Product created for the extension, with two Prices attached to it.
    expect(calls.filter((c) => c.url.endsWith('/products'))).toHaveLength(1)
    expect(calls.filter((c) => c.url.endsWith('/prices'))).toHaveLength(2)
    expect(
      calls.filter((c) => c.url.endsWith('/prices')).every((c) => c.params.get('product') === 'prod_shared_ext'),
    ).toBe(true)
  })

  it('blocks new checkouts when licensing is disabled while keeping entitlements and billing portal active', async () => {
    const { db, tenantId, sessionCookie, apiKey, extension } = await setupControlPlaneTenant({
      apiKey: 'rk_test_disabled_123456',
    })
    mockStripeFetch((path) => {
      if (path === '/products') return { body: { id: 'prod_dis_1' } }
      if (path === '/prices') return { body: { id: 'price_dis_mo' } }
      if (path === '/billing_portal/sessions') return { body: { id: 'bps_dis', url: 'https://billing.stripe.com/dis' } }
      throw new Error(`Unexpected path: ${path}`)
    })

    const planRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'recurring',
        billingInterval: 'month',
        amount: 499,
      }),
    })
    const { plan } = (await planRes.json()) as { plan: Plan }

    await seedSubscription(db, {
      tenantId,
      extensionId: extension.id,
      planId: plan.id,
      buyerEmail: 'sub@example.com',
      externalUserId: 'usr_sub',
      stripeCustomerId: 'cus_sub_1',
      status: 'active',
    })

    // Disable licensing on the extension.
    await request(`/api/v1/extensions/${extension.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ licensingEnabled: false }),
    })

    // New checkouts are blocked (400).
    const checkoutRes = await request('/api/v1/subscriptions/checkout', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        interval: 'monthly',
        externalUserId: 'usr_new',
        successUrl: 'https://app.example.com/ok',
        cancelUrl: 'https://app.example.com/cancel',
      }),
    })
    expect(checkoutRes.status).toBe(400)

    // Existing subscribers keep entitlements and Billing Portal access.
    const entRes = await request(
      `/api/v1/subscriptions/entitlements?extensionId=${extension.id}&externalUserId=usr_sub`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    )
    expect(entRes.status).toBe(200)
    expect(((await entRes.json()) as { active: boolean }).active).toBe(true)

    const portalRes = await request('/api/v1/subscriptions/portal', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        externalUserId: 'usr_sub',
        returnUrl: 'https://app.example.com/account',
      }),
    })
    expect(portalRes.status).toBe(200)
    expect(((await portalRes.json()) as { url: string }).url).toBe('https://billing.stripe.com/dis')
  })

  it('supports public GET /api/v1/portal/buy/:planId and subscription lookup + billing portal in buyer portal', async () => {
    const { db, tenantId, sessionCookie, extension } = await setupControlPlaneTenant({
      apiKey: 'rk_test_portal_sub',
    })
    mockStripeFetch((path, params) => {
      if (path === '/products') return { body: { id: 'prod_portal_1' } }
      if (path === '/prices') return { body: { id: 'price_portal_1' } }
      if (path === '/checkout/sessions') {
        return { body: { id: 'cs_portal_buy_1', url: 'https://checkout.stripe.com/c/pay/cs_portal_buy_1' } }
      }
      if (path === '/billing_portal/sessions') {
        return { body: { id: 'bps_portal_sub_1', url: 'https://billing.stripe.com/p/session/bps_portal_sub_1' } }
      }
      if (path.startsWith('/subscriptions/')) {
        return {
          body: {
            id: path.split('/').pop(),
            status: 'active',
            cancel_at_period_end: params.get('cancel_at_period_end') === 'true',
          },
        }
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    const planRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'recurring',
        billingInterval: 'month',
        amount: 499,
      }),
    })
    const { plan } = (await planRes.json()) as { plan: Plan }

    // Public buy redirect creates Stripe Checkout Session and responds 303.
    const buyRes = await request(`/api/v1/portal/buy/${plan.id}`, {
      headers: { referer: 'https://store.rxliuli.com/extensions/twitter-filter' },
    })
    expect(buyRes.status).toBe(303)
    expect(buyRes.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_portal_buy_1')

    // Fulfilled subscription is returned by /api/v1/portal/purchase/:sessionId.
    const sub = await seedSubscription(db, {
      tenantId,
      extensionId: extension.id,
      planId: plan.id,
      buyerEmail: 'PortalBuyer@Example.com',
      externalUserId: 'usr_portal_1',
      stripeCustomerId: 'cus_portal_sub_1',
      checkoutSessionId: 'cs_portal_buy_1',
      status: 'active',
    })

    const lookupRes = await request('/api/v1/portal/purchase/cs_portal_buy_1')
    expect(lookupRes.status).toBe(200)
    const lookupBody = (await lookupRes.json()) as {
      purchase: { kind: string; key: string | null; subscriptionId: string; productName: string; tier: string }
    }
    expect(lookupBody.purchase.kind).toBe('subscription')
    expect(lookupBody.purchase.key).toBeNull()
    expect(lookupBody.purchase.subscriptionId).toBe(sub.id)
    expect(lookupBody.purchase.productName).toBe('Control Plane Ext')
    expect(lookupBody.purchase.tier).toBe('pro')

    // Signed-in buyer sees subscription in /api/v1/portal/licenses and can open Billing Portal via subscriptionId.
    const magic = await createMagicLink(db, 'portalbuyer@example.com')
    const buyerSession = (await consumeMagicLink(db, magic.code))!
    const buyerCookie = `${BUYER_SESSION_COOKIE}=${buyerSession.token}`

    const listRes = await request('/api/v1/portal/licenses', { headers: { cookie: buyerCookie } })
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as {
      licenses: unknown[]
      subscriptions: Array<{
        id: string
        productName: string
        tier: string
        billingInterval: string
        canManageBilling: boolean
      }>
    }
    expect(listBody.licenses).toHaveLength(0)
    expect(listBody.subscriptions).toHaveLength(1)
    expect(listBody.subscriptions[0]!.id).toBe(sub.id)
    expect(listBody.subscriptions[0]!.billingInterval).toBe('month')
    expect(listBody.subscriptions[0]!.canManageBilling).toBe(true)

    const bpRes = await request('/api/v1/portal/billing-portal', {
      method: 'POST',
      headers: { cookie: buyerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ subscriptionId: sub.id }),
    })
    expect(bpRes.status).toBe(200)
    expect(((await bpRes.json()) as { url: string }).url).toBe('https://billing.stripe.com/p/session/bps_portal_sub_1')

    // Native Cancel at period end and Resume directly in Buyer Portal.
    const cancelRes = await request(`/api/v1/portal/subscriptions/${sub.id}/cancel`, {
      method: 'POST',
      headers: { cookie: buyerCookie },
    })
    expect(cancelRes.status).toBe(200)
    expect(
      ((await cancelRes.json()) as { subscription: { cancelAtPeriodEnd: boolean } }).subscription.cancelAtPeriodEnd,
    ).toBe(true)

    const resumeRes = await request(`/api/v1/portal/subscriptions/${sub.id}/resume`, {
      method: 'POST',
      headers: { cookie: buyerCookie },
    })
    expect(resumeRes.status).toBe(200)
    expect(
      ((await resumeRes.json()) as { subscription: { cancelAtPeriodEnd: boolean } }).subscription.cancelAtPeriodEnd,
    ).toBe(false)
  })
})
