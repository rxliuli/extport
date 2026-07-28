import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { activations, licenseEvents, licenses, magicLinks, type License, type Plan } from '../src/db'
import { createMagicLink } from '../src/lib/buyer-session'
import { createExtension, request, seedTenantWithUser } from './helpers'

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
    body: JSON.stringify({ extensionId: extension.id, name: 'My Plan', tier: 'pro' }),
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
    expect(body.purchase.productName).toBe('My Plan')
    expect(body.purchase.tier).toBe('pro')

    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    await db.update(licenses).set({ createdAt: old }).where(eq(licenses.id, license.id))
    expect((await request('/api/v1/portal/purchase/cs_portal_1')).status).toBe(410)
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
  it('lists only the signed-in buyer\'s licenses, with devices', async () => {
    const { db, license } = await setupLicensed('alice@example.com')
    await setupLicensed('bob@example.com')

    await request('/api/v1/licensing/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: license.key, productName: 'My Plan', fingerprint: 'fp-alice' }),
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
})

describe('tenant seat release + license detail', () => {
  it('releases a seat (reset event), after which check is inactive; idempotent', async () => {
    const { db, sessionCookie, license } = await setupLicensed()
    await request('/api/v1/licensing/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: license.key, productName: 'My Plan', fingerprint: 'fp-release' }),
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
      body: JSON.stringify({ code: license.key, productName: 'My Plan', fingerprint: 'fp-release' }),
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

    expect((await request(`/api/v1/licenses/${a.license.id}`, { headers: { cookie: b.sessionCookie } })).status).toBe(404)
    expect(
      (await request(`/api/v1/licenses/${a.license.id}/release`, {
        method: 'POST',
        headers: { cookie: b.sessionCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ fingerprint: 'fp-x' }),
      })).status,
    ).toBe(404)
  })
})
