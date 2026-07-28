import { newId } from '@extport/shared'
import { env } from 'cloudflare:test'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { publishTargets } from '../src/db'
import { createApiKey, createExtension, fakeZip, request, seedTenantWithUser } from './helpers'

function upload(
  auth: { key?: string; cookie?: string },
  query: string,
  body: Uint8Array,
): Promise<Response> {
  return request(`/api/v1/artifacts?${query}`, {
    method: 'POST',
    headers: {
      ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {}),
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
      'content-type': 'application/zip',
    },
    body: body as BodyInit,
  })
}

describe('extensions', () => {
  it('creates an extension and enforces per-tenant name uniqueness', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const res = await request('/api/v1/extensions', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Clean Twitter' }),
    })
    expect(res.status).toBe(201)
    const { extension } = (await res.json()) as { extension: { name: string } }
    expect(extension.name).toBe('Clean Twitter')

    // The name doubles as the licensing verification key — unique per tenant.
    const dupe = await request('/api/v1/extensions', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Clean Twitter' }),
    })
    expect(dupe.status).toBe(409)
  })

  it('enforces the free-plan extension limit', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    // Free plan allows 3 extensions — a 4th should be rejected.
    await createExtension(sessionCookie, 'First')
    await createExtension(sessionCookie, 'Second')
    await createExtension(sessionCookie, 'Third')
    const res = await request('/api/v1/extensions', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Fourth' }),
    })
    expect(res.status).toBe(403)
  })

  it('name uniqueness is per tenant, not global', async () => {
    const a = await seedTenantWithUser()
    const b = await seedTenantWithUser()
    await createExtension(a.sessionCookie, 'Same Name')
    const res = await request('/api/v1/extensions', {
      method: 'POST',
      headers: { cookie: b.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Same Name' }),
    })
    expect(res.status).toBe(201)
  })
})

describe('artifact upload', () => {
  it('uploads a zip to R2 and records metadata', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    const res = await upload({ key }, `extension=${extension.id}&version=1.2.3&store=chrome`, fakeZip())
    expect(res.status).toBe(201)
    const { artifact, warning } = (await res.json()) as {
      artifact: { r2Key: string; sha256: string; size: number; store: string; source: string }
      warning?: string
    }
    expect(artifact.store).toBe('chrome')
    expect(artifact.size).toBe(fakeZip().length)
    expect(artifact.source).toBe('cli_upload')
    // No publish target was ever configured for chrome on this extension —
    // the push still succeeds (queueLatestArtifact backfills it once one is
    // added), but it should say so rather than look identical to a real one.
    expect(warning).toMatch(/no publish target configured for store "chrome"/)

    const object = await env.ARTIFACTS.get(artifact.r2Key)
    expect(object).not.toBeNull()
    expect(object!.customMetadata?.sha256).toBe(artifact.sha256)
  })

  it('does not warn when a publish target already exists for the store', async () => {
    const { db, tenantId, sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    await db.insert(publishTargets).values({
      id: newId('publishTarget'),
      tenantId,
      extensionId: extension.id,
      store: 'chrome',
      storeItemId: 'item-1',
      credentialId: newId('storeCredential'),
    })

    const res = await upload({ key }, `extension=${extension.id}&version=1.2.3&store=chrome`, fakeZip())
    expect(res.status).toBe(201)
    const { warning } = (await res.json()) as { warning?: string }
    expect(warning).toBeUndefined()
  })

  it('is idempotent for identical re-uploads and rejects content changes', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)
    const query = `extension=${extension.id}&version=2.0.0`

    expect((await upload({ key }, query, fakeZip(1, '2.0.0'))).status).toBe(201)

    const dup = await upload({ key }, query, fakeZip(1, '2.0.0'))
    expect(dup.status).toBe(200)
    expect(((await dup.json()) as { deduplicated: boolean }).deduplicated).toBe(true)

    const conflict = await upload({ key }, query, fakeZip(2, '2.0.0'))
    expect(conflict.status).toBe(409)
  })

  it('validates version, store, body shape, and extension existence', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    expect((await upload({ key }, `extension=${extension.id}&version=v1`, fakeZip())).status).toBe(400)
    expect((await upload({ key }, `extension=${extension.id}&version=1.0&store=opera`, fakeZip())).status).toBe(400)
    expect((await upload({ key }, `extension=nope&version=1.0`, fakeZip())).status).toBe(404)
    const notZip = await upload({ key }, `extension=${extension.id}&version=1.0`, new Uint8Array([1, 2, 3, 4]))
    expect(notZip.status).toBe(400)
  })

  it('scopes extensions to the owning tenant', async () => {
    const a = await seedTenantWithUser()
    const b = await seedTenantWithUser()
    const extension = await createExtension(a.sessionCookie)
    const bKey = await createApiKey(b.sessionCookie)
    const res = await upload({ key: bKey }, `extension=${extension.id}&version=1.0.0`, fakeZip())
    expect(res.status).toBe(404)
  })

  it('accepts a fileless push for --store safari, pinning a version with no real content', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    const res = await request(`/api/v1/artifacts?extension=${extension.id}&version=0.0.8&store=safari`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.status).toBe(201)
    const { artifact } = (await res.json()) as { artifact: { r2Key: string; sha256: string; size: number; store: string } }
    expect(artifact.store).toBe('safari')
    // '' not null — r2_key/sha256 stay NOT NULL at the DB level (see migration
    // 0007's comment: relaxing that hit a real FK constraint failure on D1).
    expect(artifact.r2Key).toBe('')
    expect(artifact.sha256).toBe('')
    expect(artifact.size).toBe(0)
  })

  it('is idempotent for repeated fileless safari pushes of the same version', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)
    const query = `extension=${extension.id}&version=0.0.8&store=safari`

    const first = await request(`/api/v1/artifacts?${query}`, { method: 'POST', headers: { authorization: `Bearer ${key}` } })
    expect(first.status).toBe(201)
    const second = await request(`/api/v1/artifacts?${query}`, { method: 'POST', headers: { authorization: `Bearer ${key}` } })
    expect(second.status).toBe(200)
    expect(((await second.json()) as { deduplicated: boolean }).deduplicated).toBe(true)
  })

  it('still requires a real zip for every store other than safari', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    const chrome = await request(`/api/v1/artifacts?extension=${extension.id}&version=1.0.0&store=chrome`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(chrome.status).toBe(400)

    const universal = await request(`/api/v1/artifacts?extension=${extension.id}&version=1.0.0`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(universal.status).toBe(400)
  })

  it('accepts a firefox push with a companion source zip via multipart, and stores both in R2', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    const form = new FormData()
    form.set('file', new Blob([fakeZip(1, '1.0.0')]), 'extension.zip')
    form.set('source', new Blob([new Uint8Array([1, 2, 3, 4])]), 'source.zip')
    const res = await request(`/api/v1/artifacts?extension=${extension.id}&version=1.0.0&store=firefox`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    })
    expect(res.status).toBe(201)
    const { artifact } = (await res.json()) as { artifact: { r2Key: string; sourceR2Key: string | null; size: number } }
    expect(artifact.r2Key).not.toBeNull()
    expect(artifact.sourceR2Key).not.toBeNull()
    expect(artifact.size).toBe(fakeZip(1, '1.0.0').length)

    expect(await env.ARTIFACTS.get(artifact.r2Key)).not.toBeNull()
    expect(await env.ARTIFACTS.get(artifact.sourceR2Key!)).not.toBeNull()
  })

  it('accepts a firefox multipart push with no source part — same as a plain upload', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    const form = new FormData()
    form.set('file', new Blob([fakeZip(1, '1.0.0')]), 'extension.zip')
    const res = await request(`/api/v1/artifacts?extension=${extension.id}&version=1.0.0&store=firefox`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    })
    expect(res.status).toBe(201)
    const { artifact } = (await res.json()) as { artifact: { sourceR2Key: string | null } }
    expect(artifact.sourceR2Key).toBeNull()
  })

  it('rejects a source zip for any store other than firefox', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    const form = new FormData()
    form.set('file', new Blob([fakeZip(1, '1.0.0')]), 'extension.zip')
    form.set('source', new Blob([new Uint8Array([1, 2, 3, 4])]), 'source.zip')
    const res = await request(`/api/v1/artifacts?extension=${extension.id}&version=1.0.0&store=chrome`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    })
    expect(res.status).toBe(400)
  })

  it('rejects a zip whose manifest version does not match the pushed version', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    const res = await upload({ key }, `extension=${extension.id}&version=1.0.0&store=chrome`, fakeZip(0, '9.9.9'))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/declares version 9\.9\.9/)
  })

  it('rejects a Chrome-style build pushed to firefox', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    const chromeOnly = fakeZip(0, '1.0.0', { manifest_version: 3, version: '1.0.0', background: { service_worker: 'sw.js' } })
    const res = await upload({ key }, `extension=${extension.id}&version=1.0.0&store=firefox`, chromeOnly)
    expect(res.status).toBe(400)
    const { error } = (await res.json()) as { error: string }
    expect(error).toMatch(/gecko\.id/)
    expect(error).toMatch(/background\.scripts/)
  })

  it('rejects a universal push that would queue into a firefox target it cannot survive', async () => {
    const { db, tenantId, sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)
    await db.insert(publishTargets).values({
      id: newId('publishTarget'),
      tenantId,
      extensionId: extension.id,
      store: 'firefox',
      storeItemId: 'item-1',
      credentialId: newId('storeCredential'),
    })

    const chromeOnly = fakeZip(0, '1.0.0', { manifest_version: 3, version: '1.0.0', background: { service_worker: 'sw.js' } })
    const res = await upload({ key }, `extension=${extension.id}&version=1.0.0`, chromeOnly)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/firefox/)
  })

  it('rejects a zip with no manifest.json, and a Manifest V2 build for chrome', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    const noManifest = await upload({ key }, `extension=${extension.id}&version=1.0.0&store=chrome`, zipSync({ 'a.txt': strToU8('x') }))
    expect(noManifest.status).toBe(400)
    expect(((await noManifest.json()) as { error: string }).error).toMatch(/no parseable manifest\.json/)

    const mv2 = fakeZip(0, '1.0.0', { manifest_version: 2, version: '1.0.0' })
    const res = await upload({ key }, `extension=${extension.id}&version=1.0.0&store=chrome`, mv2)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/Manifest V3/)
  })

  it('lists artifacts for an extension', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)
    await upload({ key }, `extension=${extension.id}&version=1.0.0`, fakeZip(3, '1.0.0'))
    await upload({ key }, `extension=${extension.id}&version=1.1.0`, fakeZip(4, '1.1.0'))

    const res = await request(`/api/v1/artifacts?extension=${extension.id}`, {
      headers: { authorization: `Bearer ${key}` },
    })
    const { artifacts } = (await res.json()) as { artifacts: Array<{ version: string }> }
    expect(artifacts.map((a) => a.version).sort()).toEqual(['1.0.0', '1.1.0'])
  })
})
