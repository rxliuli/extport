import { decryptJson, newId } from '@extport/shared'
import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { publishTargets, storeCredentials, tenants } from '../src/db'
import { tenantDek } from '../src/lib/kms'
import { createApiKey, createExtension, request, seedTenantWithUser } from './helpers'

// Store adapters resolve fetch lazily from the global, so stubbing
// globalThis.fetch intercepts exactly the outbound store-API calls.
// Validation, hint derivation, and envelope encryption all stay real.
const realFetch = globalThis.fetch

function stubStoreApi(status: number, body: unknown): { calls: string[] } {
  const calls: string[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    )
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    )
  }) as typeof fetch
  return { calls }
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const chromeBody = (extra?: Record<string, unknown>) =>
  JSON.stringify({
    store: 'chrome',
    label: 'my chrome',
    credentials: {
      clientId: 'cid.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret',
      refreshToken: '1//refresh-token-abcd',
    },
    ...extra,
  })

function post(cookie: string, body: string): Promise<Response> {
  return request('/v1/credentials', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body,
  })
}

describe('credentials', () => {
  it('verifies against the store API, encrypts, and stores only ciphertext + hint', async () => {
    const { calls } = stubStoreApi(200, { access_token: 'at' })
    const { db, sessionCookie, tenantId } = await seedTenantWithUser()

    const res = await post(sessionCookie, chromeBody())
    expect(res.status).toBe(201)
    const { credential } = (await res.json()) as {
      credential: { id: string; hint: string; status: string; label: string }
    }
    expect(credential.status).toBe('active')
    expect(credential.hint).toBe('abcd')
    expect(credential.label).toBe('my chrome')
    expect(calls).toContain('https://oauth2.googleapis.com/token')

    const [row] = await db.select().from(storeCredentials).where(eq(storeCredentials.id, credential.id))
    expect(row!.encryptedPayload).not.toContain('GOCSPX')
    expect(row!.encryptedPayload).not.toContain('refresh-token')

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId))
    const dek = await tenantDek(env, tenant!)
    const decrypted = await decryptJson<{ clientSecret: string }>(dek, row!.encryptedPayload)
    expect(decrypted.clientSecret).toBe('GOCSPX-secret')
  })

  it('rejects definitively-invalid credentials without saving', async () => {
    stubStoreApi(400, { error: 'invalid_grant' })
    const { db, sessionCookie, tenantId } = await seedTenantWithUser()
    const res = await post(sessionCookie, chromeBody())
    expect(res.status).toBe(422)
    expect(((await res.json()) as { reason: string }).reason).toContain('invalid_grant')
    const rows = await db.select().from(storeCredentials).where(eq(storeCredentials.tenantId, tenantId))
    expect(rows).toHaveLength(0)
  })

  it('returns 502 on transient store-api failure without saving', async () => {
    stubStoreApi(503, 'upstream down')
    const { sessionCookie } = await seedTenantWithUser()
    expect((await post(sessionCookie, chromeBody())).status).toBe(502)
  })

  it('rejects malformed credential payloads before any network call', async () => {
    const { calls } = stubStoreApi(200, {})
    const { sessionCookie } = await seedTenantWithUser()
    const res = await post(
      sessionCookie,
      JSON.stringify({ store: 'apple', credentials: { keyId: 'K' } }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('issuerId')
    expect(calls).toHaveLength(0)
  })

  it('marks soon-expiring credentials as expiring (Edge key rotation)', async () => {
    // Edge probe: 404 for the dummy product id means the key itself is valid.
    stubStoreApi(404, 'not found')
    const { sessionCookie } = await seedTenantWithUser()
    const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
    const res = await post(
      sessionCookie,
      JSON.stringify({
        store: 'edge',
        expiresAt: soon,
        credentials: { clientId: 'c', apiKey: 'edge-key-1234' },
      }),
    )
    expect(res.status).toBe(201)
    const { credential } = (await res.json()) as { credential: { status: string; hint: string } }
    expect(credential.status).toBe('expiring')
    expect(credential.hint).toBe('1234')
  })

  it('re-verifies and flips status on /verify', async () => {
    stubStoreApi(200, { access_token: 'at' })
    const { sessionCookie } = await seedTenantWithUser()
    const created = (await (await post(sessionCookie, chromeBody())).json()) as {
      credential: { id: string }
    }

    stubStoreApi(400, { error: 'invalid_grant' })
    const res = await request(`/v1/credentials/${created.credential.id}/verify`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { credential: { status: string }; reason?: string }
    expect(body.credential.status).toBe('invalid')
    expect(body.reason).toContain('invalid_grant')
  })

  it('lists only public fields', async () => {
    stubStoreApi(200, { access_token: 'at' })
    const { sessionCookie } = await seedTenantWithUser()
    await post(sessionCookie, chromeBody())
    const res = await request('/v1/credentials', { headers: { cookie: sessionCookie } })
    const text = await res.text()
    expect(text).toContain('"hint":"abcd"')
    expect(text).not.toContain('encryptedPayload')
    expect(text).not.toContain('GOCSPX')
  })

  it('refuses deletion while a publish target references the credential', async () => {
    stubStoreApi(200, { access_token: 'at' })
    const { db, sessionCookie, tenantId } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const created = (await (await post(sessionCookie, chromeBody())).json()) as {
      credential: { id: string }
    }
    await db.insert(publishTargets).values({
      id: newId('publishTarget'),
      tenantId,
      extensionId: extension.id,
      store: 'chrome',
      storeItemId: 'abcdefg',
      credentialId: created.credential.id,
    })

    const blocked = await request(`/v1/credentials/${created.credential.id}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie },
    })
    expect(blocked.status).toBe(409)

    await db.delete(publishTargets).where(eq(publishTargets.credentialId, created.credential.id))
    const ok = await request(`/v1/credentials/${created.credential.id}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie },
    })
    expect(ok.status).toBe(200)
  })

  it('is session-only — API keys cannot touch credentials', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const key = await createApiKey(sessionCookie)
    const res = await request('/v1/credentials', { headers: { authorization: `Bearer ${key}` } })
    expect(res.status).toBe(401)
  })
})
