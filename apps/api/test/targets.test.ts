import { newId } from '@extport/shared'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { deploymentVersions, publishEvents } from '../src/db'
import { createExtension, request, seedTenantWithUser } from './helpers'

const realFetch = globalThis.fetch

// Neutral enough to satisfy chrome (access_token exchange + :fetchStatus),
// firefox (addon lookup + versions list), and credential verification for
// all stores — none of them get a shape they recognize, so they all read as
// "nothing live/in review yet" rather than throwing. Edge never calls fetch
// at all for getState(), so it doesn't need this.
async function withStoreApiStub<T>(fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }))) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
  }
}

async function createCredential(
  sessionCookie: string,
  store: string,
  fields: Record<string, string>,
  label = store,
): Promise<{ id: string }> {
  const res = await withStoreApiStub(() =>
    request('/api/v1/credentials', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ store, label, credentials: fields }),
    }),
  )
  const body = (await res.json()) as { credential?: { id: string }; error?: string }
  if (!body.credential) throw new Error(`credential setup failed: ${body.error}`)
  return body.credential
}

/** Adding a target now verifies storeItemId against the real store — same stub as credential creation. */
function addTarget(extensionId: string, sessionCookie: string, body: unknown): Promise<Response> {
  return withStoreApiStub(() =>
    request(`/api/v1/extensions/${extensionId}/targets`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const EDGE_FIELDS = { clientId: 'cid', apiKey: 'edge-key-1234' }

// ES256 test key for the safari adapter's real JWT signing (verifyCredentials
// signs a JWT before it ever reaches the stubbed fetch).
async function makeP8(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
  let binary = ''
  for (const b of pkcs8) binary += String.fromCharCode(b)
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`
}

// Static test-only RSA key (openssl genpkey) — see credentials.test.ts for provenance.
describe('publish targets', () => {
  it('creates, lists, updates, and deletes a target scoped to the extension', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'edge', EDGE_FIELDS)

    const createRes = await addTarget(extension.id, sessionCookie, { store: 'edge', storeItemId: 'product-1', credentialId: credential.id })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { target: { id: string } }

    const listRes = await request(`/api/v1/extensions/${extension.id}/targets`, { headers: { cookie: sessionCookie } })
    const list = (await listRes.json()) as { targets: Array<{ id: string; store: string; credentialLabel: string }> }
    expect(list.targets).toHaveLength(1)
    expect(list.targets[0]).toMatchObject({ id: created.target.id, store: 'edge', credentialLabel: 'edge' })

    const patchRes = await request(`/api/v1/extensions/${extension.id}/targets/${created.target.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, storeItemId: 'product-2' }),
    })
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as { target: { enabled: boolean; storeItemId: string } }
    expect(patched.target).toMatchObject({ enabled: false, storeItemId: 'product-2' })

    const deleteRes = await request(`/api/v1/extensions/${extension.id}/targets/${created.target.id}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie },
    })
    expect(deleteRes.status).toBe(200)
    const afterDelete = await request(`/api/v1/extensions/${extension.id}/targets`, { headers: { cookie: sessionCookie } })
    expect(((await afterDelete.json()) as { targets: unknown[] }).targets).toHaveLength(0)
  })

  it('rejects a credential whose store does not match', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'edge', EDGE_FIELDS)

    const res = await addTarget(extension.id, sessionCookie, { store: 'firefox', storeItemId: 'x', credentialId: credential.id })
    expect(res.status).toBe(400)
  })

  it('rejects a second target for the same store on the same extension', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'edge', EDGE_FIELDS)
    const body = { store: 'edge', storeItemId: 'x', credentialId: credential.id }

    expect((await addTarget(extension.id, sessionCookie, body)).status).toBe(201)
    expect((await addTarget(extension.id, sessionCookie, body)).status).toBe(409)
  })

  it('scopes credentials and targets to the owning tenant', async () => {
    const a = await seedTenantWithUser()
    const b = await seedTenantWithUser()
    const extension = await createExtension(a.sessionCookie)
    const bCredential = await createCredential(b.sessionCookie, 'edge', EDGE_FIELDS)

    const res = await addTarget(extension.id, a.sessionCookie, { store: 'edge', storeItemId: 'x', credentialId: bCredential.id })
    expect(res.status).toBe(404)
  })

  it('rejects when the store item cannot be verified, and creates nothing', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'firefox', { jwtIssuer: 'user:1:2', jwtSecret: 'sekrit' })

    globalThis.fetch = (() => Promise.resolve(new Response('not found', { status: 404 }))) as typeof fetch
    let res: Response
    try {
      res = await request(`/api/v1/extensions/${extension.id}/targets`, {
        method: 'POST',
        headers: { cookie: sessionCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ store: 'firefox', storeItemId: 'bogus-id', credentialId: credential.id }),
      })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(res.status).toBe(502)

    const list = await request(`/api/v1/extensions/${extension.id}/targets`, { headers: { cookie: sessionCookie } })
    expect(((await list.json()) as { targets: unknown[] }).targets).toHaveLength(0)
  })

  it('records the real store state as a baseline immediately — no manual reconcile needed', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'firefox', { jwtIssuer: 'user:1:2', jwtSecret: 'sekrit' })

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/versions/')) return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({ current_version: { version: '2.5.0' } }), { status: 200 }))
    }) as typeof fetch
    let res: Response
    try {
      res = await request(`/api/v1/extensions/${extension.id}/targets`, {
        method: 'POST',
        headers: { cookie: sessionCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ store: 'firefox', storeItemId: 'addon-1', credentialId: credential.id }),
      })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(res.status).toBe(201)

    const list = await request(`/api/v1/extensions/${extension.id}/targets`, { headers: { cookie: sessionCookie } })
    const body = (await list.json()) as { targets: Array<{ lifecycles: Array<{ liveVersion: string | null; status: string }> }> }
    expect(body.targets[0]!.lifecycles).toEqual([expect.objectContaining({ platform: null, liveVersion: '2.5.0', status: 'synced' })])
  })

  it('does not duplicate baseline rows when a target is removed and re-added for the same store', async () => {
    const { db, sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'firefox', { jwtIssuer: 'user:1:2', jwtSecret: 'sekrit' })

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/versions/')) return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({ current_version: { version: '3.0.0' } }), { status: 200 }))
    }) as typeof fetch
    try {
      const first = await request(`/api/v1/extensions/${extension.id}/targets`, {
        method: 'POST',
        headers: { cookie: sessionCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ store: 'firefox', storeItemId: 'addon-1', credentialId: credential.id }),
      })
      expect(first.status).toBe(201)
      const { target } = (await first.json()) as { target: { id: string } }

      await request(`/api/v1/extensions/${extension.id}/targets/${target.id}`, { method: 'DELETE', headers: { cookie: sessionCookie } })

      // deployment_versions history from the removed target is still there —
      // re-adding the same store shouldn't produce a second identical row.
      const second = await request(`/api/v1/extensions/${extension.id}/targets`, {
        method: 'POST',
        headers: { cookie: sessionCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ store: 'firefox', storeItemId: 'addon-1', credentialId: credential.id }),
      })
      expect(second.status).toBe(201)
    } finally {
      globalThis.fetch = realFetch
    }

    const rows = await db
      .select()
      .from(deploymentVersions)
      .where(and(eq(deploymentVersions.extensionId, extension.id), eq(deploymentVersions.store, 'firefox')))
    expect(rows).toMatchObject([{ version: '3.0.0', status: 'online' }])
  })
})

describe('publish target platforms (Safari macOS/iOS narrowing)', () => {
  it('accepts a narrower platforms list and exposes it on list', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'safari', { keyId: 'K1', issuerId: 'iss-1', privateKeyP8: await makeP8() })

    const createRes = await addTarget(extension.id, sessionCookie, {
      store: 'safari',
      storeItemId: 'app-1',
      platforms: ['macos'],
      credentialId: credential.id,
    })
    expect(createRes.status).toBe(201)

    const listRes = await request(`/api/v1/extensions/${extension.id}/targets`, { headers: { cookie: sessionCookie } })
    const list = (await listRes.json()) as { targets: Array<{ platforms: string[] | null }> }
    expect(list.targets[0]!.platforms).toEqual(['macos'])
  })

  it('defaults to null (every adapter platform) when omitted', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'safari', { keyId: 'K1', issuerId: 'iss-1', privateKeyP8: await makeP8() })

    await addTarget(extension.id, sessionCookie, { store: 'safari', storeItemId: 'app-1', credentialId: credential.id })

    const listRes = await request(`/api/v1/extensions/${extension.id}/targets`, { headers: { cookie: sessionCookie } })
    const list = (await listRes.json()) as { targets: Array<{ platforms: string[] | null }> }
    expect(list.targets[0]!.platforms).toBeNull()
  })

  it('rejects a platform the adapter does not declare', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'safari', { keyId: 'K1', issuerId: 'iss-1', privateKeyP8: await makeP8() })

    const res = await addTarget(extension.id, sessionCookie, {
      store: 'safari',
      storeItemId: 'app-1',
      platforms: ['android'],
      credentialId: credential.id,
    })
    expect(res.status).toBe(400)
  })

  it('rejects platforms for a store that does not support per-platform configuration', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'edge', EDGE_FIELDS)

    const res = await addTarget(extension.id, sessionCookie, {
      store: 'edge',
      storeItemId: 'x',
      platforms: ['macos'],
      credentialId: credential.id,
    })
    expect(res.status).toBe(400)
  })

  it('updates platforms via PATCH, and clears it back to the default with null', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'safari', { keyId: 'K1', issuerId: 'iss-1', privateKeyP8: await makeP8() })
    const createRes = await addTarget(extension.id, sessionCookie, { store: 'safari', storeItemId: 'app-1', credentialId: credential.id })
    const { target } = (await createRes.json()) as { target: { id: string } }

    const patchRes = await request(`/api/v1/extensions/${extension.id}/targets/${target.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ platforms: ['macos'] }),
    })
    expect(patchRes.status).toBe(200)
    expect(((await patchRes.json()) as { target: { platforms: string[] | null } }).target.platforms).toEqual(['macos'])

    const clearRes = await request(`/api/v1/extensions/${extension.id}/targets/${target.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ platforms: null }),
    })
    expect(clearRes.status).toBe(200)
    expect(((await clearRes.json()) as { target: { platforms: string[] | null } }).target.platforms).toBeNull()
  })
})

describe('GET /v1/extensions/matrix', () => {
  it('includes per-store deployment state for configured targets', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const credential = await createCredential(sessionCookie, 'edge', EDGE_FIELDS)
    await addTarget(extension.id, sessionCookie, { store: 'edge', storeItemId: 'x', credentialId: credential.id })

    const res = await request('/api/v1/extensions/matrix', { headers: { cookie: sessionCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      extensions: Array<{ id: string; targets: Array<{ store: string; status: string; credentialStatus: string }> }>
    }
    const entry = body.extensions.find((e) => e.id === extension.id)
    expect(entry?.targets).toEqual([
      expect.objectContaining({
        store: 'edge',
        credentialStatus: 'active',
        lifecycles: [expect.objectContaining({ platform: null, status: 'synced' })],
      }),
    ])
  })

  it('is empty for an extension with no configured targets', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const res = await request('/api/v1/extensions/matrix', { headers: { cookie: sessionCookie } })
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
      { id: newId('publishEvent'), tenantId, extensionId: extension.id, store: 'chrome', type: 'stale_review', payload: {} },
    ])

    const res = await request(`/api/v1/extensions/${extension.id}/timeline`, { headers: { cookie: sessionCookie } })
    const body = (await res.json()) as { versions: Array<{ version: string }>; events: Array<{ type: string }> }
    expect(body.versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0'])
    expect(body.events.map((e) => e.type)).toEqual(['stale_review'])
  })

  it('404s for another tenant\'s extension', async () => {
    const a = await seedTenantWithUser()
    const b = await seedTenantWithUser()
    const extension = await createExtension(a.sessionCookie)
    const res = await request(`/api/v1/extensions/${extension.id}/timeline`, { headers: { cookie: b.sessionCookie } })
    expect(res.status).toBe(404)
  })
})
