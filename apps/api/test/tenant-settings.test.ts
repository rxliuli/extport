import { describe, expect, it } from 'vitest'
import { createApiKey, request, seedTenantWithUser } from './helpers'

describe('GET /v1/tenant/settings', () => {
  it('defaults to autoWithdraw:true and the spec default stale-review days', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const res = await request('/v1/tenant/settings', { headers: { cookie: sessionCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { autoWithdraw: boolean; staleReviewDays: Record<string, number> }
    expect(body.autoWithdraw).toBe(true)
    expect(body.staleReviewDays).toEqual({ chrome: 3, firefox: 3, edge: 10, apple: 3 })
  })

  it('requires a session — an API key cannot read tenant settings', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const key = await createApiKey(sessionCookie)
    const res = await request('/v1/tenant/settings', { headers: { authorization: `Bearer ${key}` } })
    expect(res.status).toBe(401)
  })
})

describe('PATCH /v1/tenant/settings', () => {
  it('persists autoWithdraw across requests', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const patchRes = await request('/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ autoWithdraw: false }),
    })
    expect(patchRes.status).toBe(200)
    expect(((await patchRes.json()) as { autoWithdraw: boolean }).autoWithdraw).toBe(false)

    const getRes = await request('/v1/tenant/settings', { headers: { cookie: sessionCookie } })
    expect(((await getRes.json()) as { autoWithdraw: boolean }).autoWithdraw).toBe(false)
  })

  it('merges a partial staleReviewDays override without clobbering other stores', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    await request('/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ staleReviewDays: { edge: 21 } }),
    })
    const res = await request('/v1/tenant/settings', { headers: { cookie: sessionCookie } })
    const body = (await res.json()) as { staleReviewDays: Record<string, number> }
    expect(body.staleReviewDays).toEqual({ chrome: 3, firefox: 3, edge: 21, apple: 3 })
  })

  it('rejects an unknown store key', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const res = await request('/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ staleReviewDays: { opera: 5 } }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a non-positive stale-review threshold', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const res = await request('/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ staleReviewDays: { chrome: 0 } }),
    })
    expect(res.status).toBe(400)
  })

  it('does not leak settings across tenants', async () => {
    const a = await seedTenantWithUser()
    const b = await seedTenantWithUser()
    await request('/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: a.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ autoWithdraw: false }),
    })
    const res = await request('/v1/tenant/settings', { headers: { cookie: b.sessionCookie } })
    expect(((await res.json()) as { autoWithdraw: boolean }).autoWithdraw).toBe(true)
  })
})
