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

describe('supportUrl', () => {
  const patch = (cookie: string, body: unknown) =>
    request('/api/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const get = async (cookie: string) =>
    ((await (await request('/api/v1/tenant/settings', { headers: { cookie } })).json()) as { supportUrl: string | null })
      .supportUrl

  it('is null by default, accepts https and mailto, clears with null or empty', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    expect(await get(sessionCookie)).toBeNull()

    expect((await patch(sessionCookie, { supportUrl: ' https://example.com/support ' })).status).toBe(200)
    expect(await get(sessionCookie)).toBe('https://example.com/support')

    expect((await patch(sessionCookie, { supportUrl: 'mailto:help@example.com' })).status).toBe(200)
    expect(await get(sessionCookie)).toBe('mailto:help@example.com')

    // Untouched by an unrelated patch.
    await patch(sessionCookie, { staleReviewDays: { edge: 5 } })
    expect(await get(sessionCookie)).toBe('mailto:help@example.com')

    expect((await patch(sessionCookie, { supportUrl: '' })).status).toBe(200)
    expect(await get(sessionCookie)).toBeNull()
    await patch(sessionCookie, { supportUrl: 'https://example.com' })
    expect((await patch(sessionCookie, { supportUrl: null })).status).toBe(200)
    expect(await get(sessionCookie)).toBeNull()
  })

  it('rejects anything that is not an http(s) URL or a mailto: address', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    for (const bad of ['javascript:alert(1)', 'example.com', 'mailto:', 'ftp://example.com']) {
      expect((await patch(sessionCookie, { supportUrl: bad })).status).toBe(400)
    }
  })
})
