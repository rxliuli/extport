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

// Static test-only RSA key (openssl genpkey) — Chrome V2 credentials are a
// GCP service account, and signing the JWT-bearer assertion requires a real
// PKCS8 key even though the store API response itself is stubbed below.
const CHROME_TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDaLD76B9jDuu8c
F/MIKMGOIecN2+PJQ6EK+cHfkZFCxK7VxPQNq1JgTSaxoJGXI8g7tfWiFLpyspvV
CLMAsNicqIXBwcThRrVzzPKGcpKmSnjiW1wSo7tAkIoNByssP4wpjU13vPtS3AO2
PnzizPaMSyEDnrYfvp/nHNdGWmPjnCvjhv3TyP76ct4pFnLC3uZ3V5TFVOMHRpe+
6tlXJSuQPu3hBGS2vXJNs6Oxs6dVzbQF1hQ9ss5aY1FD5ojGlUljPIZjom3ahK9+
zy9qVfkEuXhV5AM3J3Hkrn4PgQHouBEdjl3f23WSijHKOyTQ9Ko3gspSGjOSZJOf
PiLcCTFBAgMBAAECggEAEPVf1HiNVrLY841AWgcs+xAokRu2qjDPEPbWpTr/7bmI
a4ZlKrYr74oKXW6WkocjVnzaLIXsSOPC7X1ryJHL10Au3B+PNFbriND1SGfEfWzh
gPAgCTTf5nC1wmB8cHKPbGAW6vKYyIPgkqcVzF1T4Wt/k/P0wnqYnFLSFZ5guv2G
bqLvQKmxHEGTLlZ8aseD0+KYUDK6d77cMlgCTSGeS6jUrRD74ARcVJkNGYeXegOI
RH4wP6zudabhi3wu25es7KKZHVQOyIQlmsmppwR45u5DeqVfKSkSsq28qeCre+XD
oa9FMgttCNiFnjWbnCDgzF+h2BAkqDBjZvVYBo/LRwKBgQDwzKcVWy4E0O9XT09p
aFdrxSN9n5PUAyiTvG1VP6k9Q9Nu5FEO7rtw9R8LWnu/3VW9sY3Z85wszBDpj6xk
tVSKdCMMbe5vENIcjA68U8rgQkop0CuhVv/PwElmikx32jyyzHy53JB2LSECR+Qe
9fNL68IghyAXCA2xO30uhsgxgwKBgQDn8fHprkD8Bi9BNCIkTSPaxw3hHlkXq1yC
RRl0MBQxxmu6/rpOeCbF/YKccvUEMY1QcOMSZz4/zNqMgTVTDrA1FvDq6IlQ5gK0
o18HFYgxxh6/FiPEY0Ete435Arrw5ae5Xs0q+D9xl5HIrcGLW+O7Fbd9SrsGGivS
IciYAVbq6wKBgQCwOXXF4VbKW4XtZbN+NshTrJCOrSxoqm8Vv35cNxzKI0snCpxv
yzMONbWkf3G1Nmw7SSfA69HNzwJJi8XkZfga42eK/yDR04ORNMbL+J6uhJT2CM0F
ZEAOcHDHREs2I1bsm05kTxDCC8DuhGJkbibB1yXY3EsVz+UFYb35QNZdtQKBgQDk
cBPUFL0H+odb7p6Zpifj9xwiVaNlfm5UFv4kwp2BEG1V9D9FvWxin3Wd5FKQWMVX
LndVzr0uVPICY9dDADpnbzrEAVYMiRytECItdfV3ICt0A7giWab9xqxjTV8UlvsD
xOzIn0rM83yvawIt4Mh/n7nh+lIMhoYWJRPNMbSLFQKBgA+kHBN9iwCfnr96EKhw
B2RZYS71oHgkzmqjOO30r5VfPmPTX0F8wjMI9ovfvVqj44Z6FulBAAJV2snfTZ0o
eSqsTEaWvgR3z8BnCoVEs6iIp4HM+fCwJJzIs2lzgIHEn268WBuAmTc33pJbmp46
eDua9gBpI8Th2Yzba8rvkv2e
-----END PRIVATE KEY-----`

const chromeBody = (extra?: Record<string, unknown>) =>
  JSON.stringify({
    store: 'chrome',
    label: 'my chrome',
    credentials: {
      publisherId: 'pub-0000abcd',
      clientEmail: 'extport@my-project.iam.gserviceaccount.com',
      privateKey: CHROME_TEST_PRIVATE_KEY,
    },
    ...extra,
  })

function post(cookie: string, body: string): Promise<Response> {
  return request('/api/v1/credentials', {
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
    expect(row!.encryptedPayload).not.toContain('BEGIN PRIVATE KEY')
    expect(row!.encryptedPayload).not.toContain('my-project.iam.gserviceaccount.com')

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId))
    const dek = await tenantDek(env, tenant!)
    const decrypted = await decryptJson<{ clientEmail: string }>(dek, row!.encryptedPayload)
    expect(decrypted.clientEmail).toBe('extport@my-project.iam.gserviceaccount.com')
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
      JSON.stringify({ store: 'safari', credentials: { keyId: 'K' } }),
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
    const res = await request(`/api/v1/credentials/${created.credential.id}/verify`, {
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
    const res = await request('/api/v1/credentials', { headers: { cookie: sessionCookie } })
    const text = await res.text()
    expect(text).toContain('"hint":"abcd"')
    expect(text).not.toContain('encryptedPayload')
    expect(text).not.toContain('BEGIN PRIVATE KEY')
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

    const blocked = await request(`/api/v1/credentials/${created.credential.id}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie },
    })
    expect(blocked.status).toBe(409)

    await db.delete(publishTargets).where(eq(publishTargets.credentialId, created.credential.id))
    const ok = await request(`/api/v1/credentials/${created.credential.id}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie },
    })
    expect(ok.status).toBe(200)
  })

  it('rotates a credential in place — same id, fresh secret, verified like a fresh create', async () => {
    stubStoreApi(200, { access_token: 'at' })
    const { db, sessionCookie, tenantId } = await seedTenantWithUser()
    const created = (await (await post(sessionCookie, chromeBody())).json()) as {
      credential: { id: string; hint: string }
    }

    const res = await request(`/api/v1/credentials/${created.credential.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials: {
          publisherId: 'pub-newnew99',
          clientEmail: 'rotated@my-project.iam.gserviceaccount.com',
          privateKey: CHROME_TEST_PRIVATE_KEY,
        },
      }),
    })
    expect(res.status).toBe(200)
    const { credential } = (await res.json()) as { credential: { id: string; hint: string; status: string } }
    expect(credential.id).toBe(created.credential.id)
    expect(credential.hint).toBe('ew99')
    expect(credential.status).toBe('active')

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId))
    const [row] = await db.select().from(storeCredentials).where(eq(storeCredentials.id, created.credential.id))
    const dek = await tenantDek(env, tenant!)
    const decrypted = await decryptJson<{ clientEmail: string }>(dek, row!.encryptedPayload)
    expect(decrypted.clientEmail).toBe('rotated@my-project.iam.gserviceaccount.com')
  })

  it('rotating a credential in active use never needs the target re-linked', async () => {
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

    const res = await request(`/api/v1/credentials/${created.credential.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials: {
          publisherId: 'pub-newnew99',
          clientEmail: 'rotated@my-project.iam.gserviceaccount.com',
          privateKey: CHROME_TEST_PRIVATE_KEY,
        },
      }),
    })
    expect(res.status).toBe(200)

    const [target] = await db.select().from(publishTargets).where(eq(publishTargets.credentialId, created.credential.id))
    expect(target).toBeDefined()
  })

  it('rejects a bad rotation without touching the existing credential', async () => {
    stubStoreApi(200, { access_token: 'at' })
    const { db, sessionCookie } = await seedTenantWithUser()
    const created = (await (await post(sessionCookie, chromeBody())).json()) as {
      credential: { id: string; hint: string }
    }
    const [before] = await db.select().from(storeCredentials).where(eq(storeCredentials.id, created.credential.id))

    stubStoreApi(400, { error: 'invalid_grant' })
    const res = await request(`/api/v1/credentials/${created.credential.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials: {
          publisherId: 'pub-badbad00',
          clientEmail: 'bad@my-project.iam.gserviceaccount.com',
          privateKey: CHROME_TEST_PRIVATE_KEY,
        },
      }),
    })
    expect(res.status).toBe(422)

    const [after] = await db.select().from(storeCredentials).where(eq(storeCredentials.id, created.credential.id))
    expect(after!.encryptedPayload).toBe(before!.encryptedPayload)
    expect(after!.hint).toBe(before!.hint)
  })

  it('404s rotating a credential that does not exist', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const res = await request(`/api/v1/credentials/${newId('storeCredential')}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: { clientId: 'c', apiKey: 'x' } }),
    })
    expect(res.status).toBe(404)
  })

  it('is session-only — API keys cannot touch credentials', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const key = await createApiKey(sessionCookie)
    const res = await request('/api/v1/credentials', { headers: { authorization: `Bearer ${key}` } })
    expect(res.status).toBe(401)
  })
})
