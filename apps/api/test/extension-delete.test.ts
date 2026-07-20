import { newId } from '@extport/shared'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { artifacts, deploymentVersions, publishEvents, publishTargets, storeCredentials } from '../src/db'
import { createExtension, fakeZip, request, seedTenantWithUser } from './helpers'

function upload(key: string, extensionSlug: string, version: string, body: Uint8Array): Promise<Response> {
  return request(`/v1/artifacts?extension=${extensionSlug}&version=${version}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/zip' },
    body: body as BodyInit,
  })
}

describe('DELETE /v1/extensions/:id', () => {
  it('removes the extension, its dependents, and R2 artifact objects', async () => {
    const { db, sessionCookie, tenantId } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)

    const keyRes = await request('/v1/keys', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    })
    const { key } = (await keyRes.json()) as { key: string }

    const uploadRes = await upload(key, extension.slug, '1.0.0', fakeZip())
    expect(uploadRes.status).toBe(201)
    const { artifact } = (await uploadRes.json()) as { artifact: { r2Key: string } }
    expect(await env.ARTIFACTS.get(artifact.r2Key)).not.toBeNull()

    // Seed rows in every table that references this extension, so deletion is
    // actually exercised across all of them, not just the happy path (artifacts).
    await db.insert(deploymentVersions).values({
      id: newId('deploymentVersion'),
      tenantId,
      extensionId: extension.id,
      store: 'chrome',
      version: '1.0.0',
    })
    await db.insert(publishEvents).values({
      id: newId('publishEvent'),
      tenantId,
      extensionId: extension.id,
      store: 'chrome',
      type: 'error',
      payloadJson: '{}',
    })
    const credentialId = newId('storeCredential')
    await db.insert(storeCredentials).values({
      id: credentialId,
      tenantId,
      store: 'chrome',
      label: 'x',
      hint: 'x',
      encryptedPayload: 'v1.a.b',
      keyVersion: 1,
    })
    await db.insert(publishTargets).values({
      id: newId('publishTarget'),
      tenantId,
      extensionId: extension.id,
      store: 'chrome',
      storeItemId: 'item-1',
      credentialId,
    })

    const deleteRes = await request(`/v1/extensions/${extension.id}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie },
    })
    expect(deleteRes.status).toBe(200)

    expect((await request(`/v1/extensions/${extension.id}`, { headers: { cookie: sessionCookie } })).status).toBe(404)
    expect(await env.ARTIFACTS.get(artifact.r2Key)).toBeNull()
    expect(await db.select().from(artifacts).where(eq(artifacts.extensionId, extension.id))).toHaveLength(0)
    expect(await db.select().from(deploymentVersions).where(eq(deploymentVersions.extensionId, extension.id))).toHaveLength(0)
    expect(await db.select().from(publishEvents).where(eq(publishEvents.extensionId, extension.id))).toHaveLength(0)
    expect(await db.select().from(publishTargets).where(eq(publishTargets.extensionId, extension.id))).toHaveLength(0)
    // The credential itself belongs to the tenant, not the extension — deleting the extension must not touch it.
    expect(await db.select().from(storeCredentials).where(eq(storeCredentials.id, credentialId))).toHaveLength(1)
  })

  it('is a clean no-op on artifacts/targets when the extension never had any', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const res = await request(`/v1/extensions/${extension.id}`, { method: 'DELETE', headers: { cookie: sessionCookie } })
    expect(res.status).toBe(200)
  })

  it('requires auth and scopes deletion to the owning tenant', async () => {
    const a = await seedTenantWithUser()
    const b = await seedTenantWithUser()
    const extension = await createExtension(a.sessionCookie)

    expect((await request(`/v1/extensions/${extension.id}`, { method: 'DELETE' })).status).toBe(401)

    const crossTenant = await request(`/v1/extensions/${extension.id}`, {
      method: 'DELETE',
      headers: { cookie: b.sessionCookie },
    })
    expect(crossTenant.status).toBe(404)

    // Still there — the cross-tenant attempt must not have deleted it.
    expect((await request(`/v1/extensions/${extension.id}`, { headers: { cookie: a.sessionCookie } })).status).toBe(200)
  })

  it('404s for an id that never existed', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const res = await request('/v1/extensions/ext_doesnotexist', { method: 'DELETE', headers: { cookie: sessionCookie } })
    expect(res.status).toBe(404)
  })
})
