import { newId } from '@extport/shared'
import { describe, expect, it } from 'vitest'
import { deploymentVersions, publishTargets } from '../src/db'
import { createExtension, request, seedTenantWithUser } from './helpers'

type Release = {
  extensionId: string
  version: string
  onlineAt: string
  announcedAt: string | null
  listingUrl: string | null
  stores: { store: string; status: string }[]
}

async function seed() {
  const t = await seedTenantWithUser()
  const withChrome = await createExtension(t.sessionCookie, 'With Chrome')
  const firefoxOnly = await createExtension(t.sessionCookie, 'Firefox Only')
  await t.db.insert(publishTargets).values({
    id: newId('publishTarget'),
    tenantId: t.tenantId,
    extensionId: withChrome.id,
    store: 'chrome',
    storeItemId: 'abcdefghijklmnop',
    credentialId: 'cred_x',
  })
  const row = (
    extensionId: string,
    store: 'chrome' | 'firefox' | 'edge',
    version: string,
    status: 'online' | 'in_review',
    updatedAt: string,
    artifactId: string | null = 'art_x',
  ) => ({
    id: newId('deploymentVersion'),
    tenantId: t.tenantId,
    extensionId,
    store,
    version,
    status,
    artifactId,
    updatedAt,
  })
  await t.db.insert(deploymentVersions).values([
    // Live on Firefox first, Chrome later: the release counts from Chrome.
    row(withChrome.id, 'firefox', '1.1.0', 'online', '2026-11-01T00:00:00.000Z'),
    row(withChrome.id, 'chrome', '1.1.0', 'online', '2026-11-03T00:00:00.000Z'),
    row(withChrome.id, 'edge', '1.1.0', 'in_review', '2026-11-01T00:00:00.000Z'),
    // Only on Firefox so far — not a release yet for a Chrome-targeted extension.
    row(withChrome.id, 'firefox', '1.2.0', 'online', '2026-11-05T00:00:00.000Z'),
    // A reconciler-observed baseline, never pushed through extport.
    row(withChrome.id, 'chrome', '1.0.0', 'online', '2026-10-01T00:00:00.000Z', null),
    // No Chrome target: the first store to go live is the baseline.
    row(firefoxOnly.id, 'firefox', '2.0.0', 'online', '2026-11-04T00:00:00.000Z'),
  ])
  return { ...t, withChrome, firefoxOnly }
}

async function list(cookie: string): Promise<Release[]> {
  const res = await request('/api/v1/releases', { headers: { cookie } })
  expect(res.status).toBe(200)
  return ((await res.json()) as { releases: Release[] }).releases
}

function mark(cookie: string, announced: boolean, items: { extensionId: string; version: string }[]) {
  return request('/api/v1/releases/announced', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ announced, items }),
  })
}

describe('/v1/releases', () => {
  it('lists releases by baseline store, newest first, with every store state', async () => {
    const { sessionCookie, withChrome, firefoxOnly } = await seed()
    const releases = await list(sessionCookie)
    expect(releases.map((r) => [r.extensionId, r.version])).toEqual([
      [firefoxOnly.id, '2.0.0'],
      [withChrome.id, '1.1.0'],
    ])
    const chrome = releases[1]!
    expect(chrome.onlineAt).toBe('2026-11-03T00:00:00.000Z')
    expect(chrome.announcedAt).toBeNull()
    expect(chrome.listingUrl).toBe('https://chromewebstore.google.com/detail/abcdefghijklmnop')
    expect(chrome.stores.map((s) => `${s.store}:${s.status}`).sort()).toEqual([
      'chrome:online',
      'edge:in_review',
      'firefox:online',
    ])
    expect(releases[0]!.listingUrl).toBeNull()
  })

  it("marks and unmarks announced; ignores other tenants' extensions", async () => {
    const { sessionCookie, withChrome } = await seed()
    const other = await seed()

    expect((await mark(sessionCookie, true, [{ extensionId: withChrome.id, version: '1.1.0' }])).status).toBe(200)
    // Idempotent.
    expect((await mark(sessionCookie, true, [{ extensionId: withChrome.id, version: '1.1.0' }])).status).toBe(200)
    expect((await list(sessionCookie)).find((r) => r.version === '1.1.0')!.announcedAt).not.toBeNull()

    // Another tenant can't touch it.
    await mark(other.sessionCookie, false, [{ extensionId: withChrome.id, version: '1.1.0' }])
    expect((await list(sessionCookie)).find((r) => r.version === '1.1.0')!.announcedAt).not.toBeNull()

    await mark(sessionCookie, false, [{ extensionId: withChrome.id, version: '1.1.0' }])
    expect((await list(sessionCookie)).find((r) => r.version === '1.1.0')!.announcedAt).toBeNull()
  })

  it('requires a session and a valid body', async () => {
    const { sessionCookie } = await seed()
    expect((await request('/api/v1/releases')).status).toBe(401)
    expect((await mark(sessionCookie, true, [])).status).toBe(400)
  })
})
