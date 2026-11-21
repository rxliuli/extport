import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { activations, licenseEvents, licenses, magicLinks, type License, type Plan } from '../src/db'
import { createMagicLink } from '../src/lib/buyer-session'
import { createExtension, request, seedTenantWithUser } from './helpers'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

async function setupLicensed(buyerEmail = 'buyer@example.com') {
  const seeded = await seedTenantWithUser()
  const { sessionCookie } = seeded
  const extension = await createExtension(sessionCookie)
  await request(`/api/v1/extensions/${extension.id}`, {
    method: 'PATCH',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ licensingEnabled: true }),
  })
  const planRes = await request('/api/v1/plans', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ extensionId: extension.id, tier: 'pro' }),
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
    const { db, sessionCookie } = seeded
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
      body: JSON.stringify({ extensionId: extension.id, tier: 'pro', entitlementType: 'recurring' }),
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
    const b = await setupLicensed('portal-buyer@example.com')

    // Tenant A: Stripe Restricted Key + license with stripeCustomerId.
    await request('/api/v1/payment-credentials', {
      method: 'POST',
      headers: { cookie: a.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'stripe', apiKey: 'rk_test_buyer_portal' }),
    })
    await a.db.update(licenses).set({ stripeCustomerId: 'cus_portal_buyer' }).where(eq(licenses.id, a.license.id))

    // Tenant B: only static billingPortalUrl on first license, and third tenant C has neither.
    await request('/api/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: b.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ billingPortalUrl: 'https://billing.stripe.com/p/login/b_static' }),
    })
    const c = await setupLicensed('portal-buyer@example.com')
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
