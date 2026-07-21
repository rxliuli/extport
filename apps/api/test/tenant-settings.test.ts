import { describe, expect, it } from 'vitest'
import { createApiKey, request, seedTenantWithUser } from './helpers'

describe('GET /v1/tenant/settings', () => {
  it('defaults to the spec default stale-review days', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const res = await request('/api/v1/tenant/settings', { headers: { cookie: sessionCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { staleReviewDays: Record<string, number> }
    expect(body.staleReviewDays).toEqual({ chrome: 3, firefox: 3, edge: 10, safari: 3 })
  })

  it('requires a session — an API key cannot read tenant settings', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const key = await createApiKey(sessionCookie)
    const res = await request('/api/v1/tenant/settings', { headers: { authorization: `Bearer ${key}` } })
    expect(res.status).toBe(401)
  })
})

describe('PATCH /v1/tenant/settings', () => {
  it('merges a partial staleReviewDays override without clobbering other stores', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    await request('/api/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ staleReviewDays: { edge: 21 } }),
    })
    const res = await request('/api/v1/tenant/settings', { headers: { cookie: sessionCookie } })
    const body = (await res.json()) as { staleReviewDays: Record<string, number> }
    expect(body.staleReviewDays).toEqual({ chrome: 3, firefox: 3, edge: 21, safari: 3 })
  })

  it('rejects an unknown store key', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const res = await request('/api/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ staleReviewDays: { opera: 5 } }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a non-positive stale-review threshold', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const res = await request('/api/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ staleReviewDays: { chrome: 0 } }),
    })
    expect(res.status).toBe(400)
  })

  it('does not leak settings across tenants', async () => {
    const a = await seedTenantWithUser()
    const b = await seedTenantWithUser()
    await request('/api/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: a.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ staleReviewDays: { chrome: 15 } }),
    })
    const res = await request('/api/v1/tenant/settings', { headers: { cookie: b.sessionCookie } })
    const body = (await res.json()) as { staleReviewDays: Record<string, number> }
    expect(body.staleReviewDays.chrome).toBe(3)
  })
})
