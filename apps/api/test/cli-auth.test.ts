import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { cliAuthExchanges, createDb } from '../src/db'
import { request, seedTenantWithUser } from './helpers'

async function start(sessionCookie: string): Promise<{ code: string }> {
  const res = await request('/api/v1/cli-auth/start', { method: 'POST', headers: { cookie: sessionCookie } })
  expect(res.status).toBe(200)
  return (await res.json()) as { code: string }
}

function exchange(code: string): Promise<Response> {
  return request('/api/v1/cli-auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
}

describe('POST /api/v1/cli-auth/start', () => {
  it('requires a session — an API key must not be able to mint another API key for itself', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const key = await (await request('/api/v1/keys', { method: 'POST', headers: { cookie: sessionCookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 't' }) })).json() as { key: string }
    const res = await request('/api/v1/cli-auth/start', { method: 'POST', headers: { authorization: `Bearer ${key.key}` } })
    expect(res.status).toBe(401)
  })

  it('mints a real API key alongside the one-time code, findable in Settings → API keys', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    await start(sessionCookie)
    const keys = (await (await request('/api/v1/keys', { headers: { cookie: sessionCookie } })).json()) as { keys: { name: string }[] }
    expect(keys.keys.some((k) => k.name === 'CLI login')).toBe(true)
  })
})

describe('POST /api/v1/cli-auth/exchange', () => {
  it('exchanges a fresh code for the real key — no auth required', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const { code } = await start(sessionCookie)

    const res = await exchange(code)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { key: string }
    expect(body.key).toMatch(/^sk_live_/)

    // The exchanged key actually works.
    const me = await request('/api/v1/me', { headers: { authorization: `Bearer ${body.key}` } })
    expect(me.status).toBe(200)
  })

  it('is single-use — a second exchange of the same code fails', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const { code } = await start(sessionCookie)

    expect((await exchange(code)).status).toBe(200)
    const second = await exchange(code)
    expect(second.status).toBe(400)
  })

  it('rejects an unknown code', async () => {
    const res = await exchange('not-a-real-code')
    expect(res.status).toBe(400)
  })

  it('rejects (and consumes) an expired code', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const { code } = await start(sessionCookie)

    // Backdate it past the 5-minute TTL directly, rather than waiting.
    const db = createDb(env.DB)
    await db.update(cliAuthExchanges).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(cliAuthExchanges.code, code))

    const res = await exchange(code)
    expect(res.status).toBe(400)
    const retry = await exchange(code)
    expect(retry.status).toBe(400) // consumed even though it was expired, not left dangling
  })

  it('requires a code in the request body', async () => {
    const res = await request('/api/v1/cli-auth/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(400)
  })
})
