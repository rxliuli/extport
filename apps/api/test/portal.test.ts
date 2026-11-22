import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activations,
  licenseEvents,
  licenses,
  magicLinks,
  subscriptionEvents,
  subscriptions,
  type License,
  type Plan,
} from '../src/db'
import { createMagicLink } from '../src/lib/buyer-session'
import {
  connectStripeAccount,
  createExtension,
  request,
  seedTenantWithUser,
  TEST_CONNECT_WEBHOOK_SECRET,
} from './helpers'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

async function setupLicensed(buyerEmail = 'buyer@example.com', opts: { connectStripe?: boolean } = {}) {
  const seeded = await seedTenantWithUser()
  const { db, tenantId, sessionCookie } = seeded
  if (opts.connectStripe !== false) {
    await connectStripeAccount(db, tenantId)
  }
  const extension = await createExtension(sessionCookie)
  if (opts.connectStripe !== false) {
    await request(`/api/v1/extensions/${extension.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ licensingEnabled: true }),
    })
  }
  const planRes = await request('/api/v1/plans', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ extensionId: extension.id, tier: 'pro', amount: 1999, stripePriceId: 'price_portal_pro' }),
  })
  const { plan } = (await planRes.json()) as { plan: Plan }
  const licenseRes = await request('/api/v1/licenses', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ planId: plan.id, buyerEmail }),
  })
  const { license } = (await licenseRes.json()) as { license: License }
  return { ...seeded, extension, plan, license }
}

async function buyerCookie(db: Awaited<ReturnType<typeof seedTenantWithUser>>['db'], email: string): Promise<string> {
  const { code } = await createMagicLink(db, email)
  const res = await request('/api/v1/portal/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  expect(res.status).toBe(200)
  const setCookie = res.headers.get('set-cookie')!
  return setCookie.split(';')[0]!
}

describe('GET /v1/portal/purchase/:sessionId', () => {
  it('404s until fulfilled, 200s within the window, 410s after 24h', async () => {
    const { db, license } = await setupLicensed()

    expect((await request('/api/v1/portal/purchase/cs_unknown')).status).toBe(404)

    await db.update(licenses).set({ checkoutSessionId: 'cs_portal_1' }).where(eq(licenses.id, license.id))
    const fresh = await request('/api/v1/portal/purchase/cs_portal_1')
    expect(fresh.status).toBe(200)
    const body = (await fresh.json()) as { purchase: { key: string; productName: string; tier: string } }
    expect(body.purchase.key).toBe(license.key)
    expect(body.purchase.productName).toBe('My Extension')
    expect(body.purchase.tier).toBe('pro')

    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    await db.update(licenses).set({ createdAt: old }).where(eq(licenses.id, license.id))
    expect((await request('/api/v1/portal/purchase/cs_portal_1')).status).toBe(410)
  })

  it('backfills country from the request once, from the buyer landing here right after paying', async () => {
    const { db, license } = await setupLicensed()
    await db.update(licenses).set({ checkoutSessionId: 'cs_portal_country' }).where(eq(licenses.id, license.id))

    await request('/api/v1/portal/purchase/cs_portal_country', { cf: { country: 'TH' } } as RequestInit)
    const [after] = await db.select().from(licenses).where(eq(licenses.id, license.id))
    expect(after!.country).toBe('TH')

    // A later poll from a different apparent location doesn't clobber it.
    await request('/api/v1/portal/purchase/cs_portal_country', { cf: { country: 'US' } } as RequestInit)
    const [again] = await db.select().from(licenses).where(eq(licenses.id, license.id))
    expect(again!.country).toBe('TH')
  })
})

describe('magic-link sign-in', () => {
  it('request-link answers identically for any address and throttles repeats', async () => {
    const { db } = await setupLicensed()
    const ask = () =>
      request('/api/v1/portal/request-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com' }),
      })
    expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(200)
    // Second request landed inside the 60s throttle — still one link row.
    const rows = await db.select().from(magicLinks).where(eq(magicLinks.email, 'nobody@example.com'))
    expect(rows).toHaveLength(1)
  })

  it('verify is single-use and rejects expired links', async () => {
    const { db } = await setupLicensed()
    const { code } = await createMagicLink(db, 'buyer@example.com')
    const verify = (c: string) =>
      request('/api/v1/portal/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: c }),
      })
    const first = await verify(code)
    expect(first.status).toBe(200)
    expect(((await first.json()) as { email: string }).email).toBe('buyer@example.com')
    expect(first.headers.get('set-cookie')).toContain('extport_buyer_session=')

    expect((await verify(code)).status).toBe(400)

    const { code: expired } = await createMagicLink(db, 'buyer@example.com')
    await db.update(magicLinks).set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect((await verify(expired)).status).toBe(400)
  })
})

describe('GET /v1/portal/licenses', () => {
  it("lists only the signed-in buyer's licenses, with devices", async () => {
    const { db, extension, license } = await setupLicensed('alice@example.com')
    await setupLicensed('bob@example.com')

    await request('/api/v1/licensing/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: license.key, extensionId: extension.id, fingerprint: 'fp-alice' }),
    })

    expect((await request('/api/v1/portal/licenses')).status).toBe(401)

    const cookie = await buyerCookie(db, 'alice@example.com')
    const res = await request('/api/v1/portal/licenses', { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      email: string
      licenses: { key: string; productName: string; devices: { fingerprint: string }[] }[]
    }
    expect(body.email).toBe('alice@example.com')
    expect(body.licenses).toHaveLength(1)
    expect(body.licenses[0]!.key).toBe(license.key)
    expect(body.licenses[0]!.devices.map((d) => d.fingerprint)).toEqual(['fp-alice'])
  })

  it('matches buyer email case-insensitively on GET /licenses', async () => {
    const { db, license } = await setupLicensed('MixedCase@Example.com')
    const cookie = await buyerCookie(db, 'mixedcase@example.com')
    const res = await request('/api/v1/portal/licenses', { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { licenses: { key: string }[] }
    expect(body.licenses.map((l) => l.key)).toEqual([license.key])
  })
})

describe('portal supportUrl', () => {
  it("carries each selling tenant's own support link per license", async () => {
    const a = await setupLicensed('shared@example.com')
    const b = await setupLicensed('shared@example.com')
    await request('/api/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: a.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ supportUrl: 'https://a.example/support' }),
    })

    const cookie = await buyerCookie(a.db, 'shared@example.com')
    const res = await request('/api/v1/portal/licenses', { headers: { cookie } })
    const body = (await res.json()) as { licenses: { key: string; supportUrl: string | null }[] }
    const byKey = new Map(body.licenses.map((l) => [l.key, l.supportUrl]))
    expect(byKey.get(a.license.key)).toBe('https://a.example/support')
    expect(byKey.get(b.license.key)).toBeNull()
  })
})

describe('portal subscription fields and billingPortalUrl', () => {
  it('returns subscription metadata and billingPortalUrl on /licenses and /purchase/:sessionId', async () => {
    const seeded = await seedTenantWithUser()
    const { db, tenantId, sessionCookie } = seeded
    await connectStripeAccount(db, tenantId)
    const extension = await createExtension(sessionCookie)
    await request(`/api/v1/extensions/${extension.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ licensingEnabled: true }),
    })
    await request('/api/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ billingPortalUrl: 'https://billing.stripe.com/p/login/portal_xyz' }),
    })
    const planRes = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: extension.id,
        tier: 'pro',
        entitlementType: 'recurring',
        amount: 499,
        stripePriceId: 'price_portal_sub',
      }),
    })
    const { plan } = (await planRes.json()) as { plan: Plan }
    const licRes = await request('/api/v1/licenses', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ planId: plan.id, buyerEmail: 'sub-portal@example.com', externalUserId: 'ext_99' }),
    })
    const { license } = (await licRes.json()) as { license: License }
    const periodEnd = new Date(Date.now() + 14 * 86400_000).toISOString()
    await db
      .update(licenses)
      .set({
        checkoutSessionId: 'cs_sub_portal_1',
        subscriptionStatus: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: true,
      })
      .where(eq(licenses.id, license.id))

    const purchaseRes = await request('/api/v1/portal/purchase/cs_sub_portal_1')
    expect(purchaseRes.status).toBe(200)
    const purchaseBody = (await purchaseRes.json()) as {
      purchase: {
        entitlementType: string
        subscriptionStatus: string
        currentPeriodEnd: string
        cancelAtPeriodEnd: boolean
        externalUserId: string
        billingPortalUrl: string
      }
    }
    expect(purchaseBody.purchase).toMatchObject({
      entitlementType: 'recurring',
      subscriptionStatus: 'active',
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true,
      externalUserId: 'ext_99',
      billingPortalUrl: 'https://billing.stripe.com/p/login/portal_xyz',
    })

    const cookie = await buyerCookie(db, 'sub-portal@example.com')
    const listRes = await request('/api/v1/portal/licenses', { headers: { cookie } })
    const listBody = (await listRes.json()) as {
      licenses: {
        key: string
        entitlementType: string
        subscriptionStatus: string
        currentPeriodEnd: string
        cancelAtPeriodEnd: boolean
        billingPortalUrl: string
      }[]
    }
    expect(listBody.licenses[0]).toMatchObject({
      key: license.key,
      entitlementType: 'recurring',
      subscriptionStatus: 'active',
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true,
      billingPortalUrl: 'https://billing.stripe.com/p/login/portal_xyz',
    })
  })
})

describe('tenant seat release + license detail', () => {
  it('releases a seat (reset event), after which check is inactive; idempotent', async () => {
    const { db, extension, sessionCookie, license } = await setupLicensed()
    await request('/api/v1/licensing/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: license.key, extensionId: extension.id, fingerprint: 'fp-release' }),
    })

    const release = () =>
      request(`/api/v1/licenses/${license.id}/release`, {
        method: 'POST',
        headers: { cookie: sessionCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ fingerprint: 'fp-release' }),
      })
    expect((await release()).status).toBe(200)

    const [row] = await db.select().from(activations).where(eq(activations.licenseId, license.id))
    expect(row!.releasedAt).not.toBeNull()
    const events = await db.select().from(licenseEvents).where(eq(licenseEvents.licenseId, license.id))
    expect(events.filter((e) => e.type === 'reset')).toHaveLength(1)

    const check = await request('/api/v1/licensing/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: license.key, extensionId: extension.id, fingerprint: 'fp-release' }),
    })
    expect(((await check.json()) as { data: { isActive: boolean } }).data.isActive).toBe(false)

    // Idempotent, and no second reset event.
    expect((await release()).status).toBe(200)
    const after = await db.select().from(licenseEvents).where(eq(licenseEvents.licenseId, license.id))
    expect(after.filter((e) => e.type === 'reset')).toHaveLength(1)
  })

  it('detail returns license + plan + activations, tenant-scoped', async () => {
    const a = await setupLicensed()
    const b = await seedTenantWithUser()

    const res = await request(`/api/v1/licenses/${a.license.id}`, { headers: { cookie: a.sessionCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { license: License; plan: Plan; activations: unknown[] }
    expect(body.license.id).toBe(a.license.id)
    expect(body.plan.tier).toBe('pro')

    expect((await request(`/api/v1/licenses/${a.license.id}`, { headers: { cookie: b.sessionCookie } })).status).toBe(
      404,
    )
    expect(
      (
        await request(`/api/v1/licenses/${a.license.id}/release`, {
          method: 'POST',
          headers: { cookie: b.sessionCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ fingerprint: 'fp-x' }),
        })
      ).status,
    ).toBe(404)
  })
})

describe('buyer portal one-click billing portal', () => {
  it('computes canManageBilling and creates Billing Portal sessions or falls back to billingPortalUrl', async () => {
    const a = await setupLicensed('portal-buyer@example.com')
    const b = await setupLicensed('portal-buyer@example.com', { connectStripe: false })

    // Tenant A: Connected Stripe account + license with stripeCustomerId.
    await a.db.update(licenses).set({ stripeCustomerId: 'cus_portal_buyer' }).where(eq(licenses.id, a.license.id))

    // Tenant B: only static billingPortalUrl on first license, and third tenant C has neither.
    await request('/api/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: b.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ billingPortalUrl: 'https://billing.stripe.com/p/login/b_static' }),
    })
    const c = await setupLicensed('portal-buyer@example.com', { connectStripe: false })
    const otherBuyer = await setupLicensed('someone-else@example.com')

    const cookie = await buyerCookie(a.db, 'portal-buyer@example.com')

    // Unauthenticated -> 401.
    expect(
      (
        await request('/api/v1/portal/billing-portal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: a.license.key }),
        })
      ).status,
    ).toBe(401)

    // GET /licenses exposes canManageBilling accurately.
    const listRes = await request('/api/v1/portal/licenses', { headers: { cookie } })
    const listBody = (await listRes.json()) as {
      licenses: { key: string; canManageBilling: boolean }[]
    }
    const byKey = new Map(listBody.licenses.map((l) => [l.key, l.canManageBilling]))
    expect(byKey.get(a.license.key)).toBe(true)
    expect(byKey.get(b.license.key)).toBe(true)
    expect(byKey.get(c.license.key)).toBe(false)

    // Tenant A license -> calls Stripe Billing Portal with return_url=${PORTAL_URL}/portal.
    const calls: URLSearchParams[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.stripe.com/v1/billing_portal/sessions')
      calls.push(new URLSearchParams(String(init?.body ?? '')))
      return new Response(
        JSON.stringify({ id: 'bps_buyer_1', url: 'https://billing.stripe.com/p/session/bps_buyer_1' }),
        {
          status: 200,
        },
      )
    }) as typeof fetch

    const portalA = await request('/api/v1/portal/billing-portal', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ key: a.license.key.toLowerCase() }),
    })
    expect(portalA.status).toBe(200)
    expect(await portalA.json()).toEqual({ url: 'https://billing.stripe.com/p/session/bps_buyer_1' })
    expect(calls[0]!.get('customer')).toBe('cus_portal_buyer')
    expect(calls[0]!.get('return_url')).toMatch(/\/portal$/)

    // Tenant B license -> falls back to static billingPortalUrl.
    const portalB = await request('/api/v1/portal/billing-portal', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ key: b.license.key }),
    })
    expect(portalB.status).toBe(200)
    expect(await portalB.json()).toEqual({ url: 'https://billing.stripe.com/p/login/b_static' })

    // Tenant C license -> 404 (no portal configured); another buyer's license -> 404.
    expect(
      (
        await request('/api/v1/portal/billing-portal', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ key: c.license.key }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await request('/api/v1/portal/billing-portal', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ key: otherBuyer.license.key }),
        })
      ).status,
    ).toBe(404)
  })
})

async function signConnectWebhook(payload: string, secret: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${payload}`))
  const sigHex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${ts},v1=${sigHex}`
}

describe('buyer portal end-of-period subscription plan switching', () => {
  let switchSeq = 0

  async function setupSubscriptionPlans(buyerEmail = 'switcher@example.com') {
    const seq = ++switchSeq
    const seeded = await seedTenantWithUser()
    const { db, tenantId, sessionCookie } = seeded
    const stripeAccountId = await connectStripeAccount(db, tenantId)
    const extension = await createExtension(sessionCookie)
    await request(`/api/v1/extensions/${extension.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ licensingEnabled: true, billingMode: 'subscription' }),
    })

    const createPlan = async (body: Record<string, unknown>) => {
      const res = await request('/api/v1/plans', {
        method: 'POST',
        headers: { cookie: sessionCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ extensionId: extension.id, entitlementType: 'recurring', ...body }),
      })
      const text = await res.text()
      expect(res.status, text).toBe(201)
      return (JSON.parse(text) as { plan: Plan }).plan
    }

    const monthlyPlan = await createPlan({
      tier: 'pro',
      billingInterval: 'month',
      amount: 499,
      currency: 'usd',
      stripePriceId: `price_pro_monthly_${seq}`,
    })
    const yearlyPlan = await createPlan({
      tier: 'pro',
      billingInterval: 'year',
      amount: 4999,
      currency: 'usd',
      stripePriceId: `price_pro_yearly_${seq}`,
    })
    const maxPlan = await createPlan({
      tier: 'max',
      billingInterval: 'month',
      amount: 1499,
      currency: 'usd',
      stripePriceId: `price_max_monthly_${seq}`,
    })
    const eurPlan = await createPlan({
      tier: 'eur_only',
      billingInterval: 'month',
      amount: 500,
      currency: 'eur',
      stripePriceId: `price_eur_monthly_${seq}`,
    })

    const nowSec = Math.floor(Date.now() / 1000)
    const endSec = nowSec + 30 * 24 * 60 * 60
    const subId = `sub_portal_switch_${seq}`
    const stripeSubId = `sub_stripe_switcher_${seq}`
    await db.insert(subscriptions).values({
      id: subId,
      tenantId,
      extensionId: extension.id,
      planId: monthlyPlan.id,
      buyerEmail,
      stripeCustomerId: `cus_switcher_${seq}`,
      stripeSubscriptionId: stripeSubId,
      status: 'active',
      currentPeriodStart: new Date(nowSec * 1000).toISOString(),
      currentPeriodEnd: new Date(endSec * 1000).toISOString(),
      cancelAtPeriodEnd: false,
      amountTotal: 499,
      currency: 'usd',
    })

    const cookie = await buyerCookie(db, buyerEmail)
    return {
      ...seeded,
      stripeAccountId,
      extension,
      monthlyPlan,
      yearlyPlan,
      maxPlan,
      eurPlan,
      subId,
      stripeSubId,
      cookie,
      nowSec,
      endSec,
    }
  }

  it('lists same-currency recurring plans, schedules and updates via Subscription Schedules, and cancels cleanly', async () => {
    const ctx = await setupSubscriptionPlans()

    // GET /licenses exposes availablePlans (same currency only) and canChangePlan=true.
    const initialList = await request('/api/v1/portal/licenses', { headers: { cookie: ctx.cookie } })
    expect(initialList.status).toBe(200)
    const initialBody = (await initialList.json()) as {
      subscriptions: Array<{
        id: string
        planId: string
        canChangePlan: boolean
        pendingPlan: { id: string; tier: string; billingInterval: string; effectiveAt: string | null } | null
        availablePlans: Array<{ id: string; tier: string; billingInterval: string; amount: number; currency: string }>
      }>
    }
    expect(initialBody.subscriptions).toHaveLength(1)
    expect(initialBody.subscriptions[0]!.canChangePlan).toBe(true)
    expect(initialBody.subscriptions[0]!.pendingPlan).toBeNull()
    expect(initialBody.subscriptions[0]!.availablePlans.map((p) => p.id)).toEqual([
      ctx.monthlyPlan.id,
      ctx.maxPlan.id,
      ctx.yearlyPlan.id,
    ])

    // Validation guards: same plan without pending change -> 400; different currency -> 400.
    expect(
      (
        await request(`/api/v1/portal/subscriptions/${ctx.subId}/change-plan`, {
          method: 'POST',
          headers: { cookie: ctx.cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ planId: ctx.monthlyPlan.id }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await request(`/api/v1/portal/subscriptions/${ctx.subId}/change-plan`, {
          method: 'POST',
          headers: { cookie: ctx.cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ planId: ctx.eurPlan.id }),
        })
      ).status,
    ).toBe(400)

    // Mock Stripe Subscription Schedules API.
    const stripeCalls: Array<{ method: string; url: string; params: Record<string, string> }> = []
    let activeScheduleId: string | null = null
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')).entries())
      stripeCalls.push({ method, url, params })

      if (method === 'GET' && url.endsWith(`/subscriptions/${ctx.stripeSubId}`)) {
        return new Response(
          JSON.stringify({
            id: ctx.stripeSubId,
            status: 'active',
            cancel_at_period_end: false,
            current_period_start: ctx.nowSec,
            current_period_end: ctx.endSec,
            schedule: activeScheduleId,
            items: { data: [{ price: { id: ctx.monthlyPlan.stripePriceId } }] },
          }),
          { status: 200 },
        )
      }
      if (method === 'POST' && url.endsWith('/subscription_schedules')) {
        activeScheduleId = 'sub_sched_test_1'
        return new Response(
          JSON.stringify({
            id: activeScheduleId,
            status: 'active',
            phases: [
              {
                start_date: ctx.nowSec,
                end_date: ctx.endSec,
                items: [{ price: ctx.monthlyPlan.stripePriceId, quantity: 1 }],
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (method === 'GET' && url.endsWith('/subscription_schedules/sub_sched_test_1')) {
        return new Response(
          JSON.stringify({
            id: 'sub_sched_test_1',
            status: activeScheduleId ? 'active' : 'released',
            phases: [
              {
                start_date: ctx.nowSec,
                end_date: ctx.endSec,
                items: [{ price: ctx.monthlyPlan.stripePriceId, quantity: 1 }],
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (method === 'POST' && url.endsWith('/subscription_schedules/sub_sched_test_1/release')) {
        activeScheduleId = null
        return new Response(JSON.stringify({ id: 'sub_sched_test_1', status: 'released' }), { status: 200 })
      }
      if (method === 'POST' && url.endsWith('/subscription_schedules/sub_sched_test_1')) {
        return new Response(JSON.stringify({ id: 'sub_sched_test_1', status: 'active' }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: { message: `unexpected ${method} ${url}` } }), { status: 404 })
    }) as typeof fetch

    // 1. Schedule Monthly -> Yearly.
    const scheduleRes = await request(`/api/v1/portal/subscriptions/${ctx.subId}/change-plan`, {
      method: 'POST',
      headers: { cookie: ctx.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ planId: ctx.yearlyPlan.id }),
    })
    const scheduleText = await scheduleRes.text()
    expect(scheduleRes.status, scheduleText).toBe(200)
    const scheduleBody = JSON.parse(scheduleText) as {
      subscription: { pendingPlan: { id: string; billingInterval: string; effectiveAt: string } }
    }
    expect(scheduleBody.subscription.pendingPlan.id).toBe(ctx.yearlyPlan.id)
    expect(scheduleBody.subscription.pendingPlan.billingInterval).toBe('year')
    expect(scheduleBody.subscription.pendingPlan.effectiveAt).toBe(new Date(ctx.endSec * 1000).toISOString())

    const createSchedCalls = stripeCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/subscription_schedules'))
    expect(createSchedCalls).toHaveLength(1)
    expect(createSchedCalls[0]!.params.from_subscription).toBe(ctx.stripeSubId)

    const updateSchedCall = stripeCalls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/subscription_schedules/sub_sched_test_1'),
    )
    expect(updateSchedCall?.params.end_behavior).toBe('release')
    expect(updateSchedCall?.params.proration_behavior).toBe('none')
    expect(updateSchedCall?.params['phases[0][items][0][price]']).toBe(ctx.monthlyPlan.stripePriceId)
    expect(updateSchedCall?.params['phases[1][items][0][price]']).toBe(ctx.yearlyPlan.stripePriceId)

    // 2. Re-schedule to Max Monthly -> reuses existing schedule (no second from_subscription call).
    const switchAgainRes = await request(`/api/v1/portal/subscriptions/${ctx.subId}/change-plan`, {
      method: 'POST',
      headers: { cookie: ctx.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ planId: ctx.maxPlan.id }),
    })
    expect(switchAgainRes.status).toBe(200)
    expect(stripeCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/subscription_schedules'))).toHaveLength(1)

    // 3. Cancel the scheduled change via DELETE /scheduled-change -> releases schedule and clears pendingPlan.
    const cancelChangeRes = await request(`/api/v1/portal/subscriptions/${ctx.subId}/scheduled-change`, {
      method: 'DELETE',
      headers: { cookie: ctx.cookie },
    })
    expect(cancelChangeRes.status).toBe(200)
    expect(stripeCalls.some((c) => c.url.endsWith('/subscription_schedules/sub_sched_test_1/release'))).toBe(true)

    const [afterCancel] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, ctx.subId))
    expect(afterCancel!.pendingPlanId).toBeNull()
    expect(afterCancel!.stripeScheduleId).toBeNull()

    const events = await ctx.db.select().from(subscriptionEvents).where(eq(subscriptionEvents.subscriptionId, ctx.subId))
    expect(events.map((e) => e.payload['action'])).toEqual([
      'plan_change_scheduled',
      'plan_change_scheduled',
      'plan_change_canceled',
    ])
  })

  it('handles mutual exclusion with cancel_at_period_end and syncs planId via Stripe webhook', async () => {
    const ctx = await setupSubscriptionPlans('mutex@example.com')
    let cancelAtPeriodEnd = true
    let activeScheduleId: string | null = null
    await ctx.db.update(subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(subscriptions.id, ctx.subId))

    const stripeCalls: Array<{ method: string; url: string; params: Record<string, string> }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')).entries())
      stripeCalls.push({ method, url, params })

      if (method === 'GET' && url.endsWith(`/subscriptions/${ctx.stripeSubId}`)) {
        return new Response(
          JSON.stringify({
            id: ctx.stripeSubId,
            status: 'active',
            cancel_at_period_end: cancelAtPeriodEnd,
            current_period_start: ctx.nowSec,
            current_period_end: ctx.endSec,
            schedule: activeScheduleId,
            items: { data: [{ price: { id: ctx.monthlyPlan.stripePriceId } }] },
          }),
          { status: 200 },
        )
      }
      if (method === 'POST' && url.endsWith(`/subscriptions/${ctx.stripeSubId}`)) {
        cancelAtPeriodEnd = params.cancel_at_period_end === 'true'
        return new Response(
          JSON.stringify({ id: ctx.stripeSubId, status: 'active', cancel_at_period_end: cancelAtPeriodEnd }),
          { status: 200 },
        )
      }
      if (method === 'POST' && url.endsWith('/subscription_schedules')) {
        activeScheduleId = 'sub_sched_mutex_1'
        return new Response(
          JSON.stringify({
            id: activeScheduleId,
            status: 'active',
            phases: [
              {
                start_date: ctx.nowSec,
                end_date: ctx.endSec,
                items: [{ price: ctx.monthlyPlan.stripePriceId, quantity: 1 }],
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (method === 'POST' && url.endsWith('/subscription_schedules/sub_sched_mutex_1/release')) {
        activeScheduleId = null
        return new Response(JSON.stringify({ id: 'sub_sched_mutex_1', status: 'released' }), { status: 200 })
      }
      if (method === 'POST' && url.endsWith('/subscription_schedules/sub_sched_mutex_1')) {
        return new Response(JSON.stringify({ id: 'sub_sched_mutex_1', status: 'active' }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: { message: `unexpected ${method} ${url}` } }), { status: 404 })
    }) as typeof fetch

    // 1. Scheduling a plan change while cancelAtPeriodEnd=true automatically resumes the subscription.
    const scheduleRes = await request(`/api/v1/portal/subscriptions/${ctx.subId}/change-plan`, {
      method: 'POST',
      headers: { cookie: ctx.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ planId: ctx.yearlyPlan.id }),
    })
    expect(scheduleRes.status).toBe(200)
    expect(cancelAtPeriodEnd).toBe(false)
    const [afterSchedule] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, ctx.subId))
    expect(afterSchedule!.cancelAtPeriodEnd).toBe(false)
    expect(afterSchedule!.pendingPlanId).toBe(ctx.yearlyPlan.id)

    // 2. Canceling the subscription while a schedule is pending releases the schedule and clears pendingPlanId.
    const cancelRes = await request(`/api/v1/portal/subscriptions/${ctx.subId}/cancel`, {
      method: 'POST',
      headers: { cookie: ctx.cookie },
    })
    expect(cancelRes.status).toBe(200)
    expect(activeScheduleId).toBeNull()
    expect(cancelAtPeriodEnd).toBe(true)
    const [afterCancel] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, ctx.subId))
    expect(afterCancel!.cancelAtPeriodEnd).toBe(true)
    expect(afterCancel!.pendingPlanId).toBeNull()
    expect(afterCancel!.stripeScheduleId).toBeNull()

    // 3. Re-schedule to Yearly, then simulate Stripe webhook when the new period begins on Yearly price.
    const reScheduleRes = await request(`/api/v1/portal/subscriptions/${ctx.subId}/change-plan`, {
      method: 'POST',
      headers: { cookie: ctx.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ planId: ctx.yearlyPlan.id }),
    })
    expect(reScheduleRes.status).toBe(200)

    const nextStart = ctx.endSec
    const nextEnd = nextStart + 365 * 24 * 60 * 60
    const webhookPayload = JSON.stringify({
      id: 'evt_sub_plan_switched_1',
      type: 'customer.subscription.updated',
      account: ctx.stripeAccountId,
      data: {
        object: {
          id: ctx.stripeSubId,
          customer: 'cus_switcher_2',
          status: 'active',
          cancel_at_period_end: false,
          schedule: null,
          items: {
            data: [
              {
                current_period_start: nextStart,
                current_period_end: nextEnd,
                price: { id: ctx.yearlyPlan.stripePriceId },
              },
            ],
          },
        },
      },
    })
    const sig = await signConnectWebhook(webhookPayload, TEST_CONNECT_WEBHOOK_SECRET)
    const whRes = await request('/api/v1/licensing/webhooks/stripe/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      body: webhookPayload,
    })
    expect(whRes.status, await whRes.text()).toBe(200)

    const [afterWebhook] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, ctx.subId))
    expect(afterWebhook!.planId).toBe(ctx.yearlyPlan.id)
    expect(afterWebhook!.pendingPlanId).toBeNull()
    expect(afterWebhook!.stripeScheduleId).toBeNull()
  })
})
