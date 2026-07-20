import { decryptJson, encryptJson } from '@extport/shared'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { tenants } from '../src/db'
import { tenantDek } from '../src/lib/kms'
import { request, seedTenantWithUser } from './helpers'

describe('health', () => {
  it('responds ok without auth', async () => {
    const res = await request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('auth', () => {
  it('rejects /v1/me without credentials', async () => {
    const res = await request('/v1/me')
    expect(res.status).toBe(401)
  })

  it('resolves /v1/me from a session cookie', async () => {
    const { tenantId, sessionCookie } = await seedTenantWithUser()
    const res = await request('/v1/me', { headers: { cookie: sessionCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { authType: string; tenant: { id: string }; user: { email: string } }
    expect(body.authType).toBe('session')
    expect(body.tenant.id).toBe(tenantId)
    expect(body.user.email).toBe('dev@acme.test')
  })

  it('rejects garbage bearer tokens', async () => {
    const res = await request('/v1/me', {
      headers: { authorization: 'Bearer sk_live_' + 'x'.repeat(40) },
    })
    expect(res.status).toBe(401)
  })
})

describe('api keys', () => {
  it('creates, uses, lists and revokes a key', async () => {
    const { tenantId, sessionCookie } = await seedTenantWithUser()

    // Create — plaintext returned exactly once.
    const createRes = await request('/v1/keys', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ci' }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { id: string; key: string; masked: string }
    expect(created.key).toMatch(/^sk_live_[0-9a-zA-Z]{40}$/)

    // The key authenticates as the tenant.
    const meRes = await request('/v1/me', {
      headers: { authorization: `Bearer ${created.key}` },
    })
    expect(meRes.status).toBe(200)
    const me = (await meRes.json()) as { authType: string; tenant: { id: string }; user: null }
    expect(me.authType).toBe('api_key')
    expect(me.tenant.id).toBe(tenantId)
    expect(me.user).toBeNull()

    // Listing shows the mask, never the key or its hash.
    const listRes = await request('/v1/keys', { headers: { cookie: sessionCookie } })
    const list = (await listRes.json()) as { keys: Array<{ id: string; masked: string }> }
    expect(list.keys.map((k) => k.id)).toContain(created.id)
    expect(JSON.stringify(list)).not.toContain(created.key)

    // API keys cannot manage keys.
    const forbidden = await request('/v1/keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${created.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'escalation' }),
    })
    expect(forbidden.status).toBe(401)

    // Revoke — the key stops working.
    const revokeRes = await request(`/v1/keys/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie },
    })
    expect(revokeRes.status).toBe(200)
    const afterRevoke = await request('/v1/me', {
      headers: { authorization: `Bearer ${created.key}` },
    })
    expect(afterRevoke.status).toBe(401)
  })

  it('scopes revocation to the owning tenant', async () => {
    const a = await seedTenantWithUser()
    const b = await seedTenantWithUser()
    const createRes = await request('/v1/keys', {
      method: 'POST',
      headers: { cookie: a.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a-key' }),
    })
    const created = (await createRes.json()) as { id: string }
    const crossRevoke = await request(`/v1/keys/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: b.sessionCookie },
    })
    expect(crossRevoke.status).toBe(404)
  })
})

describe('tenant envelope encryption', () => {
  it('provisions a DEK on signup that round-trips credential payloads', async () => {
    const { db, tenantId } = await seedTenantWithUser()
    const [tenant] = await db.select().from(tenants)
    const row = tenant && tenant.id === tenantId ? tenant : (await db.select().from(tenants)).find((t) => t.id === tenantId)!

    const dek = await tenantDek(env, row)
    const secret = { store: 'firefox', issuer: 'user:123', jwtSecret: 'amo-secret' }
    const payload = await encryptJson(dek, secret)
    expect(payload).not.toContain('amo-secret')
    expect(await decryptJson(dek, payload)).toEqual(secret)
  })

  it('gives each tenant a distinct DEK', async () => {
    const a = await seedTenantWithUser()
    const rows = await a.db.select().from(tenants)
    const deks = await Promise.all(rows.map((t) => tenantDek(env, t)))
    const encoded = deks.map((d) => [...d].join(','))
    expect(new Set(encoded).size).toBe(encoded.length)
  })
})
