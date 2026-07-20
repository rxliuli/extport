import { newId } from '@extport/shared'
import { describe, expect, it } from 'vitest'
import { deploymentVersions, publishEvents } from '../src/db'
import { createExtension, request, seedTenantWithUser } from './helpers'

const realFetch = globalThis.fetch

async function createCredential(
  sessionCookie: string,
  store: string,
  fields: Record<string, string>,
  label = store,
): Promise<{ id: string }> {
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }))) as typeof fetch
  const res = await request('/v1/credentials', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ store, label, credentials: fields }),
  })
  globalThis.fetch = realFetch
  const body = (await res.json()) as { credential?: { id: string }; error?: string }
  if (!body.credential) throw new Error(`credential setup failed: ${body.error}`)
  return body.credential
}

const EDGE_FIELDS = { clientId: 'cid', apiKey: 'edge-key-1234' }

// Static test-only RSA key (openssl genpkey) — see credentials.test.ts for provenance.
// Chrome's verifyCredentials signs a real JWT-bearer assertion before ever calling
// fetch, so a garbage privateKey fails locally without reaching the (stubbed) network.
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

describe('publish targets', () => {
  it('creates, lists, updates, and deletes a target scoped to the extension', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'edge', EDGE_FIELDS)

    const createRes = await request(`/v1/extensions/${extension.id}/targets`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ store: 'edge', storeItemId: 'product-1', credentialId: credential.id }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { target: { id: string } }

    const listRes = await request(`/v1/extensions/${extension.id}/targets`, { headers: { cookie: sessionCookie } })
    const list = (await listRes.json()) as { targets: Array<{ id: string; store: string; credentialLabel: string }> }
    expect(list.targets).toHaveLength(1)
    expect(list.targets[0]).toMatchObject({ id: created.target.id, store: 'edge', credentialLabel: 'edge' })

    const patchRes = await request(`/v1/extensions/${extension.id}/targets/${created.target.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, storeItemId: 'product-2' }),
    })
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as { target: { enabled: boolean; storeItemId: string } }
    expect(patched.target).toMatchObject({ enabled: false, storeItemId: 'product-2' })

    const deleteRes = await request(`/v1/extensions/${extension.id}/targets/${created.target.id}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie },
    })
    expect(deleteRes.status).toBe(200)
    const afterDelete = await request(`/v1/extensions/${extension.id}/targets`, { headers: { cookie: sessionCookie } })
    expect(((await afterDelete.json()) as { targets: unknown[] }).targets).toHaveLength(0)
  })

  it('rejects a credential whose store does not match', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'edge', EDGE_FIELDS)

    const res = await request(`/v1/extensions/${extension.id}/targets`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ store: 'firefox', storeItemId: 'x', credentialId: credential.id }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a second target for the same store on the same extension', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'edge', EDGE_FIELDS)
    const body = JSON.stringify({ store: 'edge', storeItemId: 'x', credentialId: credential.id })

    expect(
      (await request(`/v1/extensions/${extension.id}/targets`, { method: 'POST', headers: { cookie: sessionCookie, 'content-type': 'application/json' }, body })).status,
    ).toBe(201)
    expect(
      (await request(`/v1/extensions/${extension.id}/targets`, { method: 'POST', headers: { cookie: sessionCookie, 'content-type': 'application/json' }, body })).status,
    ).toBe(409)
  })

  it('enforces the free-plan store-per-extension limit', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const edge = await createCredential(sessionCookie, 'edge', EDGE_FIELDS, 'edge-cred')
    const firefox = await createCredential(sessionCookie, 'firefox', { jwtIssuer: 'user:1:2', jwtSecret: 'sekrit' }, 'ff-cred')

    await request(`/v1/extensions/${extension.id}/targets`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ store: 'edge', storeItemId: 'x', credentialId: edge.id }),
    })
    await request(`/v1/extensions/${extension.id}/targets`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ store: 'firefox', storeItemId: 'y', credentialId: firefox.id }),
    })
    // Free plan allows 2 stores per extension — a 3rd should be rejected.
    const chrome = await createCredential(
      sessionCookie,
      'chrome',
      { publisherId: 'p', clientEmail: 'sa@x.iam.gserviceaccount.com', privateKey: CHROME_TEST_PRIVATE_KEY },
      'chrome-cred',
    )
    const res = await request(`/v1/extensions/${extension.id}/targets`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ store: 'chrome', storeItemId: 'z', credentialId: chrome.id }),
    })
    expect(res.status).toBe(403)
  })

  it('scopes credentials and targets to the owning tenant', async () => {
    const a = await seedTenantWithUser()
    const b = await seedTenantWithUser()
    const extension = await createExtension(a.sessionCookie)
    const bCredential = await createCredential(b.sessionCookie, 'edge', EDGE_FIELDS)

    const res = await request(`/v1/extensions/${extension.id}/targets`, {
      method: 'POST',
      headers: { cookie: a.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ store: 'edge', storeItemId: 'x', credentialId: bCredential.id }),
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /v1/extensions/matrix', () => {
  it('includes per-store deployment state for configured targets', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'edge', EDGE_FIELDS)
    await request(`/v1/extensions/${extension.id}/targets`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ store: 'edge', storeItemId: 'x', credentialId: credential.id }),
    })

    const res = await request('/v1/extensions/matrix', { headers: { cookie: sessionCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      extensions: Array<{ id: string; targets: Array<{ store: string; status: string; credentialStatus: string }> }>
    }
    const entry = body.extensions.find((e) => e.id === extension.id)
    expect(entry?.targets).toEqual([expect.objectContaining({ store: 'edge', status: 'synced', credentialStatus: 'active' })])
  })

  it('is empty for an extension with no configured targets', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const res = await request('/v1/extensions/matrix', { headers: { cookie: sessionCookie } })
    const body = (await res.json()) as { extensions: Array<{ id: string; targets: unknown[] }> }
    expect(body.extensions.find((e) => e.id === extension.id)?.targets).toEqual([])
  })
})

describe('GET /v1/extensions/:id/timeline', () => {
  it('returns deployment_versions and publish_events newest-first, scoped to the extension and tenant', async () => {
    const { db, sessionCookie, tenantId } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    await db.insert(deploymentVersions).values([
      { id: newId('deploymentVersion'), tenantId, extensionId: extension.id, store: 'chrome', version: '1.0.0', status: 'online' },
      { id: newId('deploymentVersion'), tenantId, extensionId: extension.id, store: 'chrome', version: '1.1.0', status: 'in_review' },
    ])
    await db.insert(publishEvents).values([
      { id: newId('publishEvent'), tenantId, extensionId: extension.id, store: 'chrome', type: 'stale_review', payloadJson: '{}' },
    ])

    const res = await request(`/v1/extensions/${extension.id}/timeline`, { headers: { cookie: sessionCookie } })
    const body = (await res.json()) as { versions: Array<{ version: string }>; events: Array<{ type: string }> }
    expect(body.versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0'])
    expect(body.events.map((e) => e.type)).toEqual(['stale_review'])
  })

  it('404s for another tenant\'s extension', async () => {
    const a = await seedTenantWithUser()
    const b = await seedTenantWithUser()
    const extension = await createExtension(a.sessionCookie)
    const res = await request(`/v1/extensions/${extension.id}/timeline`, { headers: { cookie: b.sessionCookie } })
    expect(res.status).toBe(404)
  })
})
