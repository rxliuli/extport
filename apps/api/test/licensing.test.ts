import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { activations, licenseEvents, licenses, plans, type License, type Plan } from '../src/db'
import { createExtension, request, seedTenantWithUser } from './helpers'

const KEY_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/

function activate(body: Record<string, unknown>): Promise<Response> {
  return request('/api/v1/licensing/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function check(body: Record<string, unknown>): Promise<Response> {
  return request('/api/v1/licensing/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

interface WireResult {
  success: boolean
  message?: string
  data?: { tier?: string | null; expiresAt?: string | null; isActive?: boolean }
  error?: string
}

async function setupLicensedProduct(opts: { maxActivations?: number; licensingEnabled?: boolean } = {}) {
  const seeded = await seedTenantWithUser()
  const { sessionCookie } = seeded
  const extension = await createExtension(sessionCookie)
  if (opts.licensingEnabled !== false) {
    const patch = await request(`/api/v1/extensions/${extension.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ licensingEnabled: true }),
    })
    expect(patch.status).toBe(200)
  }
  const productRes = await request('/api/v1/plans', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      extensionId: extension.id,
      name: 'My Plan',
      tier: 'pro',
      ...(opts.maxActivations !== undefined ? { maxActivations: opts.maxActivations } : {}),
    }),
  })
  expect(productRes.status).toBe(201)
  const { plan } = (await productRes.json()) as { plan: Plan }
  const licenseRes = await request('/api/v1/licenses', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ planId: plan.id, buyerEmail: 'buyer@example.com' }),
  })
  expect(licenseRes.status).toBe(201)
  const { license } = (await licenseRes.json()) as { license: License }
  return { ...seeded, extension, plan, license }
}

describe('plans & manual license issuance', () => {
  it('issues a well-formed key and snapshots maxActivations from the plan', async () => {
    const { db, plan, license } = await setupLicensedProduct({ maxActivations: 5 })
    expect(plan.maxActivations).toBe(5)
    expect(license.key).toMatch(KEY_RE)
    expect(license.maxActivations).toBe(5)
    expect(license.source).toBe('manual')
    expect(license.status).toBe('active')
    expect(license.entitlementType).toBe('perpetual')

    const events = await db.select().from(licenseEvents).where(eq(licenseEvents.licenseId, license.id))
    expect(events.map((e) => e.type)).toEqual(['issued'])
  })

  it('rejects the reserved "free" tier and duplicate (extension, tier) pairs', async () => {
    const { sessionCookie, extension } = await setupLicensedProduct()
    const freeTier = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ extensionId: extension.id, name: 'My Plan', tier: 'free' }),
    })
    expect(freeTier.status).toBe(400)

    const dupe = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ extensionId: extension.id, name: 'My Plan', tier: 'pro' }),
    })
    expect(dupe.status).toBe(409)

    // A second tier of the same extension is fine.
    const basic = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ extensionId: extension.id, name: 'My Plan', tier: 'basic' }),
    })
    expect(basic.status).toBe(201)
  })

  it('requires auth and scopes both resources to the owning tenant', async () => {
    const a = await setupLicensedProduct()
    const b = await seedTenantWithUser()

    expect((await request('/api/v1/plans', { method: 'POST', body: JSON.stringify({}) })).status).toBe(401)
    expect((await request('/api/v1/licenses')).status).toBe(401)

    // Tenant B cannot create a plan on A's extension nor issue for A's plan.
    const crossProduct = await request('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: b.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ extensionId: a.extension.id, name: 'X', tier: 'pro' }),
    })
    expect(crossProduct.status).toBe(404)

    const crossLicense = await request('/api/v1/licenses', {
      method: 'POST',
      headers: { cookie: b.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ planId: a.plan.id, buyerEmail: 'x@example.com' }),
    })
    expect(crossLicense.status).toBe(404)

    // B's listings don't leak A's rows.
    const listed = await request('/api/v1/licenses', { headers: { cookie: b.sessionCookie } })
    expect(((await listed.json()) as { licenses: License[] }).licenses).toHaveLength(0)
  })

  it('PATCH edits only maxActivations; snapshots on existing licenses stay', async () => {
    const { sessionCookie, plan, license } = await setupLicensedProduct()
    const res = await request(`/api/v1/plans/${plan.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ maxActivations: 10 }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { plan: Plan }).plan.maxActivations).toBe(10)

    // Already-issued licenses keep their snapshot; new ones get the new limit.
    const oldLicense = await request(`/api/v1/licenses/${license.id}`, { headers: { cookie: sessionCookie } })
    expect(((await oldLicense.json()) as { license: License }).license.maxActivations).toBe(3)
    const issued = await request('/api/v1/licenses', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ planId: plan.id, buyerEmail: 'later@example.com' }),
    })
    expect(((await issued.json()) as { license: License }).license.maxActivations).toBe(10)

    // Cross-tenant PATCH must miss.
    const b = await seedTenantWithUser()
    const cross = await request(`/api/v1/plans/${plan.id}`, {
      method: 'PATCH',
      headers: { cookie: b.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ maxActivations: 99 }),
    })
    expect(cross.status).toBe(404)
  })

  it('lists licenses filtered by plan', async () => {
    const { sessionCookie, license, plan } = await setupLicensedProduct()
    const res = await request(`/api/v1/licenses?plan=${plan.id}`, { headers: { cookie: sessionCookie } })
    const body = (await res.json()) as { licenses: License[] }
    expect(body.licenses.map((l) => l.id)).toEqual([license.id])

    const other = await request('/api/v1/licenses?plan=prod_nope', { headers: { cookie: sessionCookie } })
    expect(((await other.json()) as { licenses: License[] }).licenses).toHaveLength(0)
  })
})

describe('POST /v1/licensing/activate', () => {
  it('activates a new device and is idempotent for the same fingerprint', async () => {
    const { db, license } = await setupLicensedProduct()
    const res = await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as WireResult
    expect(body.success).toBe(true)
    expect(body.data).toEqual({ tier: 'pro', expiresAt: null })

    const again = await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })
    expect(((await again.json()) as WireResult).success).toBe(true)

    const rows = await db.select().from(activations).where(eq(activations.licenseId, license.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.lastHeartbeatAt).not.toBeNull()
    expect(rows[0]!.releasedAt).toBeNull()

    const events = await db.select().from(licenseEvents).where(eq(licenseEvents.licenseId, license.id))
    expect(events.filter((e) => e.type === 'activated')).toHaveLength(1)
  })

  it('normalizes code case', async () => {
    const { license } = await setupLicensedProduct()
    const res = await activate({ code: license.key.toLowerCase(), productName: 'My Plan', fingerprint: 'fp-1' })
    expect(((await res.json()) as WireResult).success).toBe(true)
  })

  it('fails cleanly for an unknown code, a wrong plan name, and a refunded license', async () => {
    const { db, license } = await setupLicensedProduct()

    const unknown = (await (await activate({ code: 'AAAA-AAAA-AAAA-AAAA', productName: 'My Plan', fingerprint: 'fp-1' })).json()) as WireResult
    expect(unknown.success).toBe(false)
    expect(unknown.message).toMatch(/invalid/)

    const wrongProduct = (await (await activate({ code: license.key, productName: 'Other Plan', fingerprint: 'fp-1' })).json()) as WireResult
    expect(wrongProduct.success).toBe(false)

    await db.update(licenses).set({ status: 'refunded' }).where(eq(licenses.id, license.id))
    const refunded = (await (await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })).json()) as WireResult
    expect(refunded.success).toBe(false)
    expect(refunded.message).toMatch(/no longer active/)
  })

  it('404s when the extension has licensing disabled', async () => {
    const { license } = await setupLicensedProduct({ licensingEnabled: false })
    const res = await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })
    expect(res.status).toBe(404)
  })

  it('enforces the seat limit', async () => {
    const { license } = await setupLicensedProduct({ maxActivations: 1 })
    expect(((await (await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })).json()) as WireResult).success).toBe(true)
    const second = (await (await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-2' })).json()) as WireResult
    expect(second.success).toBe(false)
    expect(second.message).toMatch(/maximum number of devices \(1\)/)
  })

  it('lazily releases a seat idle past 30 days — and only then', async () => {
    const { db, license } = await setupLicensedProduct({ maxActivations: 1 })
    await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-old' })

    // 29 days idle: still occupying the seat, new device rejected.
    const days29 = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString()
    await db.update(activations).set({ lastHeartbeatAt: days29 }).where(eq(activations.licenseId, license.id))
    expect(((await (await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-new' })).json()) as WireResult).success).toBe(false)

    // 31 days idle: decays at the moment the new device asks.
    const days31 = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    await db.update(activations).set({ lastHeartbeatAt: days31 }).where(eq(activations.deviceFingerprint, 'fp-old'))
    expect(((await (await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-new' })).json()) as WireResult).success).toBe(true)

    const [old] = await db.select().from(activations).where(and(eq(activations.licenseId, license.id), eq(activations.deviceFingerprint, 'fp-old')))
    expect(old!.releasedAt).not.toBeNull()
    const events = await db.select().from(licenseEvents).where(eq(licenseEvents.licenseId, license.id))
    expect(events.filter((e) => e.type === 'seat_released')).toHaveLength(1)
  })

  it('reuses the activation row when a released device returns', async () => {
    const { db, license } = await setupLicensedProduct({ maxActivations: 2 })
    await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })
    await db.update(activations).set({ releasedAt: new Date().toISOString() }).where(eq(activations.deviceFingerprint, 'fp-1'))

    const res = (await (await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })).json()) as WireResult
    expect(res.success).toBe(true)
    const rows = await db.select().from(activations).where(eq(activations.licenseId, license.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.releasedAt).toBeNull()
  })
})

describe('POST /v1/licensing/check', () => {
  it('reports an active device and heartbeats it, with a 12h write throttle', async () => {
    const { db, license } = await setupLicensedProduct()
    await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })

    // Aged 13h: the check refreshes the heartbeat.
    const hours13 = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString()
    await db.update(activations).set({ lastHeartbeatAt: hours13 }).where(eq(activations.licenseId, license.id))
    const res = (await (await check({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })).json()) as WireResult
    expect(res.success).toBe(true)
    expect(res.data).toEqual({ isActive: true, tier: 'pro', expiresAt: null })
    const [afterStale] = await db.select().from(activations).where(eq(activations.licenseId, license.id))
    expect(afterStale!.lastHeartbeatAt! > hours13).toBe(true)

    // Aged 1h: fresh enough, the write is skipped.
    const hours1 = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
    await db.update(activations).set({ lastHeartbeatAt: hours1 }).where(eq(activations.licenseId, license.id))
    await check({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })
    const [afterFresh] = await db.select().from(activations).where(eq(activations.licenseId, license.id))
    expect(afterFresh!.lastHeartbeatAt).toBe(hours1)
  })

  it('is inactive for unknown devices, released seats, revoked licenses, and unknown codes', async () => {
    const { db, license } = await setupLicensedProduct()
    await activate({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })

    const unknownDevice = (await (await check({ code: license.key, productName: 'My Plan', fingerprint: 'fp-other' })).json()) as WireResult
    expect(unknownDevice.data?.isActive).toBe(false)

    const unknownCode = (await (await check({ code: 'AAAA-AAAA-AAAA-AAAA', productName: 'My Plan', fingerprint: 'fp-1' })).json()) as WireResult
    expect(unknownCode.success).toBe(true)
    expect(unknownCode.data).toEqual({ isActive: false, tier: null, expiresAt: null })

    await db.update(activations).set({ releasedAt: new Date().toISOString() }).where(eq(activations.licenseId, license.id))
    const released = (await (await check({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })).json()) as WireResult
    expect(released.data?.isActive).toBe(false)

    await db.update(activations).set({ releasedAt: null }).where(eq(activations.licenseId, license.id))
    await db.update(licenses).set({ status: 'refunded' }).where(eq(licenses.id, license.id))
    const refunded = (await (await check({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })).json()) as WireResult
    expect(refunded.data?.isActive).toBe(false)
  })

  it('404s when the extension has licensing disabled', async () => {
    const { license } = await setupLicensedProduct({ licensingEnabled: false })
    expect((await check({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })).status).toBe(404)
  })

  it('answers CORS preflight and marks responses cross-origin-readable', async () => {
    // Extensions without host_permissions fetch under normal CORS rules —
    // the public licensing surface must be reachable from any origin.
    const preflight = await request('/api/v1/licensing/check', {
      method: 'OPTIONS',
      headers: {
        origin: 'chrome-extension://abcdefghijklmnop',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')

    const { license } = await setupLicensedProduct()
    const res = await check({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('never activates a device on its own', async () => {
    const { db, license } = await setupLicensedProduct()
    await check({ code: license.key, productName: 'My Plan', fingerprint: 'fp-1' })
    expect(await db.select().from(activations).where(eq(activations.licenseId, license.id))).toHaveLength(0)
  })
})

describe('extension deletion vs issued licenses', () => {
  it('blocks deletion while licenses exist, allows it for license-less plans', async () => {
    const { sessionCookie, extension, db, license } = await setupLicensedProduct()
    const blocked = await request(`/api/v1/extensions/${extension.id}`, { method: 'DELETE', headers: { cookie: sessionCookie } })
    expect(blocked.status).toBe(409)
    expect((await request(`/api/v1/extensions/${extension.id}`, { headers: { cookie: sessionCookie } })).status).toBe(200)

    // With the license gone (test-only surgery), deletion proceeds and takes
    // the plan with it.
    await db.delete(licenses).where(eq(licenses.id, license.id))
    const allowed = await request(`/api/v1/extensions/${extension.id}`, { method: 'DELETE', headers: { cookie: sessionCookie } })
    expect(allowed.status).toBe(200)
    expect(await db.select().from(plans).where(eq(plans.extensionId, extension.id))).toHaveLength(0)
  })
})
