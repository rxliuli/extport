import { describe, expect, it } from 'vitest'
import { request, seedTenantWithUser } from './helpers'

describe('closed-beta gate (tenants.status)', () => {
  it('lets an active tenant through to a gated route', async () => {
    const { sessionCookie } = await seedTenantWithUser({ status: 'active' })
    const res = await request('/api/v1/extensions', { headers: { cookie: sessionCookie } })
    expect(res.status).toBe(200)
  })

  it('blocks a pending tenant from a gated route', async () => {
    const { sessionCookie } = await seedTenantWithUser({ status: 'pending' })
    const res = await request('/api/v1/extensions', { headers: { cookie: sessionCookie } })
    expect(res.status).toBe(403)
  })

  it('blocks a pending tenant from starting a CLI login exchange', async () => {
    const { sessionCookie } = await seedTenantWithUser({ status: 'pending' })
    const res = await request('/api/v1/cli-auth/start', {
      method: 'POST',
      headers: { cookie: sessionCookie },
    })
    expect(res.status).toBe(403)
  })

  it('still answers GET /v1/me for a pending tenant, reporting its status', async () => {
    const { sessionCookie } = await seedTenantWithUser({ status: 'pending' })
    const res = await request('/api/v1/me', { headers: { cookie: sessionCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tenant: { status: string } }
    expect(body.tenant.status).toBe('pending')
  })
})
