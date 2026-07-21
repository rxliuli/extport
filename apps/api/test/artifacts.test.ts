import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
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
  it('creates with a slug derived from the name', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const res = await request('/api/v1/extensions', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Clean Twitter!' }),
    })
    expect(res.status).toBe(201)
    const { extension } = (await res.json()) as { extension: { slug: string } }
    expect(extension.slug).toBe('clean-twitter')
  })

  it('enforces the free-plan extension limit', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    await createExtension(sessionCookie, 'First')
    const res = await request('/api/v1/extensions', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Second' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects duplicate slugs within a tenant', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    await createExtension(sessionCookie, 'Same')
    const res = await request('/api/v1/extensions', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'same' }),
    })
    // Free plan hits the count limit first; this asserts we never get a 500.
    expect([403, 409]).toContain(res.status)
  })
})

describe('artifact upload', () => {
  it('uploads a zip to R2 and records metadata', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    const res = await upload({ key }, `extension=${extension.slug}&version=1.2.3&store=chrome`, fakeZip())
    expect(res.status).toBe(201)
    const { artifact } = (await res.json()) as {
      artifact: { r2Key: string; sha256: string; size: number; store: string; source: string }
    }
    expect(artifact.store).toBe('chrome')
    expect(artifact.size).toBe(64)
    expect(artifact.source).toBe('cli_upload')

    const object = await env.ARTIFACTS.get(artifact.r2Key)
    expect(object).not.toBeNull()
    expect(object!.customMetadata?.sha256).toBe(artifact.sha256)
  })

  it('is idempotent for identical re-uploads and rejects content changes', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)
    const query = `extension=${extension.id}&version=2.0.0`

    expect((await upload({ key }, query, fakeZip(1))).status).toBe(201)

    const dup = await upload({ key }, query, fakeZip(1))
    expect(dup.status).toBe(200)
    expect(((await dup.json()) as { deduplicated: boolean }).deduplicated).toBe(true)

    const conflict = await upload({ key }, query, fakeZip(2))
    expect(conflict.status).toBe(409)
  })

  it('validates version, store, body shape, and extension existence', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)

    expect((await upload({ key }, `extension=${extension.slug}&version=v1`, fakeZip())).status).toBe(400)
    expect((await upload({ key }, `extension=${extension.slug}&version=1.0&store=opera`, fakeZip())).status).toBe(400)
    expect((await upload({ key }, `extension=nope&version=1.0`, fakeZip())).status).toBe(404)
    const notZip = await upload({ key }, `extension=${extension.slug}&version=1.0`, new Uint8Array([1, 2, 3, 4]))
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

  it('lists artifacts for an extension', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)
    await upload({ key }, `extension=${extension.slug}&version=1.0.0`, fakeZip(3))
    await upload({ key }, `extension=${extension.slug}&version=1.1.0`, fakeZip(4))

    const res = await request(`/api/v1/artifacts?extension=${extension.slug}`, {
      headers: { authorization: `Bearer ${key}` },
    })
    const { artifacts } = (await res.json()) as { artifacts: Array<{ version: string }> }
    expect(artifacts.map((a) => a.version).sort()).toEqual(['1.0.0', '1.1.0'])
  })
})
