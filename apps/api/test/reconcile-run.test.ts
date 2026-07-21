import { encryptJson, newId, type Store } from '@extport/shared'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  artifacts,
  createDb,
  deploymentVersions,
  extensions,
  publishEvents,
  publishTargets,
  storeCredentials,
  tenants,
  type DeploymentVersion,
} from '../src/db'
import { provisionTenantDek, tenantDek } from '../src/lib/kms'
import type { Notification, Notifier } from '../src/lib/notify'
import { runReconciliation } from '../src/reconcile/run'
import { createApiKey, createExtension, request, seedTenantWithUser } from './helpers'

// Same static test-only RSA key used in credentials.test.ts.
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

interface ScenarioOptions {
  settingsJson?: string
  credentialStatus?: 'active' | 'invalid'
  artifacts?: { version: string; store?: Store | null }[]
  versions?: { version: string; status: DeploymentVersion['status']; submittedAt?: string }[]
}

async function setupChromeScenario(opts: ScenarioOptions = {}) {
  const db = createDb(env.DB)
  const tenantId = newId('tenant')
  const dekInfo = await provisionTenantDek(env)
  await db.insert(tenants).values({
    id: tenantId,
    name: 't',
    email: 't@test.com',
    dekEncrypted: dekInfo.dekEncrypted,
    dekKeyVersion: dekInfo.dekKeyVersion,
    settingsJson: opts.settingsJson ?? '{}',
  })

  const extensionId = newId('extension')
  await db.insert(extensions).values({
    id: extensionId,
    tenantId,
    name: 'Ext',
    slug: `ext-${extensionId.slice(-10).toLowerCase()}`,
    publishingEnabled: true,
  })

  const dek = await tenantDek(env, dekInfo)
  const encryptedPayload = await encryptJson(dek, {
    publisherId: 'pub-1',
    clientEmail: 'sa@x.iam.gserviceaccount.com',
    privateKey: CHROME_TEST_PRIVATE_KEY,
  })
  const credentialId = newId('storeCredential')
  await db.insert(storeCredentials).values({
    id: credentialId,
    tenantId,
    store: 'chrome',
    label: 'chrome',
    hint: '0001',
    encryptedPayload,
    keyVersion: dekInfo.dekKeyVersion,
    status: opts.credentialStatus ?? 'active',
  })

  const targetId = newId('publishTarget')
  await db.insert(publishTargets).values({
    id: targetId,
    tenantId,
    extensionId,
    store: 'chrome',
    storeItemId: 'item-1',
    credentialId,
  })

  const artifactIdByVersion = new Map<string, string>()
  for (const a of opts.artifacts ?? []) {
    const r2Key = `artifacts/${tenantId}/${extensionId}/${a.version}/${a.store ?? 'universal'}.zip`
    const artifactId = newId('artifact')
    await db.insert(artifacts).values({
      id: artifactId,
      tenantId,
      extensionId,
      version: a.version,
      store: a.store ?? null,
      source: 'cli_upload',
      r2Key,
      sha256: 'a'.repeat(64),
      size: 4,
    })
    await env.ARTIFACTS.put(r2Key, new Uint8Array([1, 2, 3, 4]))
    artifactIdByVersion.set(a.version, artifactId)
  }

  for (const v of opts.versions ?? []) {
    await db.insert(deploymentVersions).values({
      id: newId('deploymentVersion'),
      tenantId,
      extensionId,
      store: 'chrome',
      version: v.version,
      status: v.status,
      artifactId: v.status === 'queued' ? (artifactIdByVersion.get(v.version) ?? null) : null,
      submittedAt: v.submittedAt,
    })
  }

  return { db, tenantId, extensionId, credentialId, targetId }
}

interface Route {
  test: (url: string, init?: RequestInit) => boolean
  respond: () => { status: number; body?: unknown }
}

function routedFetch(routes: Route[]): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    const route = routes.find((r) => r.test(url, init))
    if (!route) throw new Error(`no stub route for ${init?.method ?? 'GET'} ${url}`)
    const { status, body } = route.respond()
    return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body ?? {}), { status }))
  }) as typeof fetch
  return { fetch: fetchFn, calls }
}

function chromeRoutes(opts: { fetchStatus?: unknown; uploadOk?: boolean; publishOk?: boolean; cancelOk?: boolean } = {}): Route[] {
  return [
    { test: (u) => u === 'https://oauth2.googleapis.com/token', respond: () => ({ status: 200, body: { access_token: 'at' } }) },
    { test: (u) => u.endsWith(':fetchStatus'), respond: () => ({ status: 200, body: opts.fetchStatus ?? {} }) },
    {
      test: (u, i) => u.endsWith(':upload') && i?.method === 'POST',
      respond: () => (opts.uploadOk === false ? { status: 400, body: 'bad zip' } : { status: 200, body: { uploadState: 'SUCCEEDED' } }),
    },
    {
      test: (u, i) => u.endsWith(':publish') && i?.method === 'POST',
      respond: () => (opts.publishOk === false ? { status: 400, body: 'publish rejected' } : { status: 200, body: {} }),
    },
    {
      test: (u, i) => u.endsWith(':cancelSubmission') && i?.method === 'POST',
      respond: () => (opts.cancelOk === false ? { status: 500, body: 'cancel failed' } : { status: 200, body: {} }),
    },
  ]
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function recordingNotifier(): { notifier: Notifier; sent: Notification[] } {
  const sent: Notification[] = []
  return { notifier: { send: (n) => Promise.resolve(void sent.push(n)) }, sent }
}

async function versionsFor(db: ReturnType<typeof createDb>, extensionId: string) {
  return db.select().from(deploymentVersions).where(eq(deploymentVersions.extensionId, extensionId)).orderBy(deploymentVersions.version)
}

async function targetFor(db: ReturnType<typeof createDb>, extensionId: string) {
  const [row] = await db.select().from(publishTargets).where(eq(publishTargets.extensionId, extensionId))
  return row!
}

async function eventsFor(db: ReturnType<typeof createDb>, extensionId: string) {
  return db.select().from(publishEvents).where(eq(publishEvents.extensionId, extensionId))
}

describe('runReconciliation — fresh publish', () => {
  it('submits the queued artifact and notifies', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({
      artifacts: [{ version: '1.0.0' }],
      versions: [{ version: '1.0.0', status: 'queued' }],
    })
    const { fetch, calls } = routedFetch(chromeRoutes())
    globalThis.fetch = fetch
    const { notifier, sent } = recordingNotifier()

    const summary = await runReconciliation(env, db, { tenantId }, notifier)
    expect(summary).toEqual({ processed: 1, submitted: 1, blocked: 0, errors: 0 })

    const rows = await versionsFor(db, extensionId)
    expect(rows).toMatchObject([{ version: '1.0.0', status: 'in_review' }])
    expect(rows[0]!.submittedAt).not.toBeNull()
    expect(calls.some((c) => c.url.endsWith(':publish'))).toBe(true)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 't@test.com' })
    expect(sent[0]!.subject).toContain('v1.0.0')
  })
})

describe('runReconciliation — already synced', () => {
  it('does nothing and never calls upload/publish', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({
      versions: [{ version: '1.0.0', status: 'online' }],
    })
    const { fetch, calls } = routedFetch(
      chromeRoutes({ fetchStatus: { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.0.0' }] } } }),
    )
    globalThis.fetch = fetch
    const { notifier, sent } = recordingNotifier()

    const summary = await runReconciliation(env, db, { tenantId }, notifier)
    expect(summary).toEqual({ processed: 1, submitted: 0, blocked: 0, errors: 0 })
    expect(await versionsFor(db, extensionId)).toMatchObject([{ version: '1.0.0', status: 'online' }])
    expect(calls.some((c) => c.url.endsWith(':upload') || c.url.endsWith(':publish'))).toBe(false)
    expect(await eventsFor(db, extensionId)).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
})

describe('runReconciliation — baseline discovery', () => {
  it('records an in-review version the store reports that we have no local row for at all', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({})
    globalThis.fetch = routedFetch(
      chromeRoutes({ fetchStatus: { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.0.0' }] } } }),
    ).fetch
    const { notifier, sent } = recordingNotifier()

    const summary = await runReconciliation(env, db, { tenantId }, notifier)
    expect(summary).toEqual({ processed: 1, submitted: 0, blocked: 0, errors: 0 })
    const rows = await versionsFor(db, extensionId)
    expect(rows).toMatchObject([{ version: '1.0.0', status: 'in_review' }])
    // Unknown when it was actually submitted — left null rather than guessed at "now".
    expect(rows[0]!.submittedAt).toBeNull()
    expect(sent).toHaveLength(0)
  })

  it('discovers live and in-review simultaneously in one tick', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({})
    globalThis.fetch = routedFetch(
      chromeRoutes({
        fetchStatus: {
          publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.0.0' }] },
          submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.1.0' }] },
        },
      }),
    ).fetch

    await runReconciliation(env, db, { tenantId }, recordingNotifier().notifier)
    const rows = await versionsFor(db, extensionId)
    expect(rows).toMatchObject([
      { version: '1.0.0', status: 'online' },
      { version: '1.1.0', status: 'in_review' },
    ])
  })
})

describe('runReconciliation — waiting on the exact version already in review', () => {
  it('stays in_review without resubmitting', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({
      versions: [{ version: '1.1.0', status: 'in_review', submittedAt: new Date().toISOString() }],
    })
    globalThis.fetch = routedFetch(
      chromeRoutes({ fetchStatus: { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.1.0' }] } } }),
    ).fetch
    const { notifier, sent } = recordingNotifier()

    const summary = await runReconciliation(env, db, { tenantId }, notifier)
    expect(summary).toEqual({ processed: 1, submitted: 0, blocked: 0, errors: 0 })
    expect(await versionsFor(db, extensionId)).toMatchObject([{ version: '1.1.0', status: 'in_review' }])
    expect(sent).toHaveLength(0)
  })
})

describe('runReconciliation — approval', () => {
  it('flips the in-review row to online and notifies', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({
      versions: [{ version: '1.1.0', status: 'in_review', submittedAt: new Date().toISOString() }],
    })
    globalThis.fetch = routedFetch(
      chromeRoutes({ fetchStatus: { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.1.0' }] } } }),
    ).fetch
    const { notifier, sent } = recordingNotifier()

    await runReconciliation(env, db, { tenantId }, notifier)
    expect(await versionsFor(db, extensionId)).toMatchObject([{ version: '1.1.0', status: 'online' }])
    expect(await eventsFor(db, extensionId)).toHaveLength(0)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toContain('v1.1.0 is live')
  })
})

describe('runReconciliation — rejection frees the slot for a newer version', () => {
  it('rejects the old row and submits the queued one in the same tick', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({
      artifacts: [{ version: '1.1.0' }, { version: '1.2.0' }],
      versions: [
        { version: '1.1.0', status: 'in_review', submittedAt: new Date().toISOString() },
        { version: '1.2.0', status: 'queued' },
      ],
    })
    globalThis.fetch = routedFetch(
      chromeRoutes({ fetchStatus: { submittedItemRevisionStatus: { state: 'REJECTED', distributionChannels: [{ crxVersion: '1.1.0' }] } } }),
    ).fetch
    const { notifier, sent } = recordingNotifier()

    const summary = await runReconciliation(env, db, { tenantId }, notifier)
    expect(summary.submitted).toBe(1)
    const rows = await versionsFor(db, extensionId)
    expect(rows).toMatchObject([
      { version: '1.1.0', status: 'rejected' },
      { version: '1.2.0', status: 'in_review' },
    ])

    expect(sent).toHaveLength(2)
    expect(sent[0]!.subject).toContain('rejected')
    expect(sent[0]!.text).toContain('does not expose rejection reasons via API')
    expect(sent[1]!.subject).toContain('v1.2.0')
  })
})

describe('runReconciliation — blocked (no auto-withdraw)', () => {
  const scenario = {
    artifacts: [{ version: '1.0.0' }, { version: '1.1.0' }],
    versions: [
      { version: '1.0.0', status: 'in_review' as const, submittedAt: new Date().toISOString() },
      { version: '1.1.0', status: 'queued' as const },
    ],
  }
  const pendingFetchStatus = { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.0.0' }] } }

  it('blocks without calling cancelSubmission — never cancels an in-review version', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario(scenario)
    const { fetch, calls } = routedFetch(chromeRoutes({ fetchStatus: pendingFetchStatus }))
    globalThis.fetch = fetch
    const { notifier, sent } = recordingNotifier()

    const summary = await runReconciliation(env, db, { tenantId }, notifier)
    expect(summary).toEqual({ processed: 1, submitted: 0, blocked: 1, errors: 0 })
    expect(await versionsFor(db, extensionId)).toMatchObject([
      { version: '1.0.0', status: 'in_review' },
      { version: '1.1.0', status: 'queued' },
    ])
    expect(calls.some((c) => c.url.endsWith(':cancelSubmission'))).toBe(false)
    expect(await eventsFor(db, extensionId)).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('leaves both rows untouched across repeated ticks while it stays blocked', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario(scenario)
    globalThis.fetch = routedFetch(chromeRoutes({ fetchStatus: pendingFetchStatus })).fetch

    await runReconciliation(env, db, { tenantId }, recordingNotifier().notifier)
    const first = await versionsFor(db, extensionId)
    await runReconciliation(env, db, { tenantId }, recordingNotifier().notifier)
    const second = await versionsFor(db, extensionId)

    expect(second.map((v) => ({ version: v.version, status: v.status, updatedAt: v.updatedAt }))).toEqual(
      first.map((v) => ({ version: v.version, status: v.status, updatedAt: v.updatedAt })),
    )
  })
})

describe('runReconciliation — failure isolation', () => {
  it('marks an invalid credential as a target-level error without any network call, and does not affect other tenants', async () => {
    const bad = await setupChromeScenario({
      artifacts: [{ version: '1.0.0' }],
      versions: [{ version: '1.0.0', status: 'queued' }],
      credentialStatus: 'invalid',
    })
    const good = await setupChromeScenario({
      artifacts: [{ version: '1.0.0' }],
      versions: [{ version: '1.0.0', status: 'queued' }],
    })
    globalThis.fetch = routedFetch(chromeRoutes()).fetch

    // No tenant filter — simulates a real cron sweep across everyone. Other
    // test files' leftover rows share this file's D1 storage (isolation is
    // per-file, not per-test, in this harness), so assertions below are
    // scoped to these two extensions rather than global summary totals.
    await runReconciliation(env, good.db, {}, recordingNotifier().notifier)

    const badTarget = await targetFor(good.db, bad.extensionId)
    expect(badTarget.lastErrorDetail).toMatch(/failed verification/)
    expect((await eventsFor(good.db, bad.extensionId))[0]).toMatchObject({ type: 'error' })
    expect(await versionsFor(good.db, bad.extensionId)).toMatchObject([{ version: '1.0.0', status: 'queued' }])

    expect(await versionsFor(good.db, good.extensionId)).toMatchObject([{ version: '1.0.0', status: 'in_review' }])
  })

  it('records the error event and email once on transition, not again on every failing tick', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({
      artifacts: [{ version: '1.0.0' }],
      versions: [{ version: '1.0.0', status: 'queued' }],
      credentialStatus: 'invalid',
    })
    const { notifier, sent } = recordingNotifier()

    await runReconciliation(env, db, { tenantId }, notifier)
    await runReconciliation(env, db, { tenantId }, notifier)
    await runReconciliation(env, db, { tenantId }, notifier)

    expect((await eventsFor(db, extensionId)).map((e) => e.type)).toEqual(['error'])
    expect(sent).toHaveLength(1)
    // The freshest failure detail still lands on the target every tick.
    expect((await targetFor(db, extensionId)).lastErrorDetail).toMatch(/failed verification/)
  })

  it('records a recovered event (no email) when an erroring target succeeds again', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({
      versions: [{ version: '1.0.0', status: 'online' }],
    })
    // Seed the "was erroring" state directly, as if a previous tick failed.
    await db
      .update(publishTargets)
      .set({ lastErrorDetail: 'chrome fetchStatus failed (503)', lastErrorAt: new Date().toISOString() })
      .where(eq(publishTargets.extensionId, extensionId))
    globalThis.fetch = routedFetch(
      chromeRoutes({ fetchStatus: { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.0.0' }] } } }),
    ).fetch
    const { notifier, sent } = recordingNotifier()

    await runReconciliation(env, db, { tenantId }, notifier)
    expect((await eventsFor(db, extensionId)).map((e) => e.type)).toEqual(['recovered'])
    expect((await targetFor(db, extensionId)).lastErrorDetail).toBeNull()
    expect(sent).toHaveLength(0)

    // Staying healthy is steady state — no second recovered event.
    await runReconciliation(env, db, { tenantId }, notifier)
    expect((await eventsFor(db, extensionId)).map((e) => e.type)).toEqual(['recovered'])
  })

  it('reports a missing R2 object as an error without crashing the whole tick', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({})
    // Insert an artifact + queued row whose R2 object was never actually written.
    const artifactId = newId('artifact')
    await db.insert(artifacts).values({
      id: artifactId,
      tenantId,
      extensionId,
      version: '1.0.0',
      store: null,
      source: 'cli_upload',
      r2Key: 'artifacts/does/not/exist.zip',
      sha256: 'b'.repeat(64),
      size: 4,
    })
    await db.insert(deploymentVersions).values({
      id: newId('deploymentVersion'),
      tenantId,
      extensionId,
      store: 'chrome',
      version: '1.0.0',
      status: 'queued',
      artifactId,
    })
    globalThis.fetch = routedFetch(chromeRoutes()).fetch

    const summary = await runReconciliation(env, db, { tenantId }, recordingNotifier().notifier)
    expect(summary).toEqual({ processed: 1, submitted: 0, blocked: 0, errors: 1 })
    const target = await targetFor(db, extensionId)
    expect(target.lastErrorDetail).toMatch(/missing from R2/)
  })
})

describe('POST /v1/extensions/:id/reconcile — manual trigger', () => {
  it('reconciles just the requested extension and returns a summary', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    // No publish target configured — reconcile should be a safe no-op (0 processed), not an error.
    const res = await request(`/api/v1/extensions/${extension.id}/reconcile`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { summary: { processed: number } }
    expect(body.summary.processed).toBe(0)
  })

  it('requires auth and scopes to the owning tenant', async () => {
    const a = await seedTenantWithUser()
    const b = await seedTenantWithUser()
    const extension = await createExtension(a.sessionCookie)

    expect((await request(`/api/v1/extensions/${extension.id}/reconcile`, { method: 'POST' })).status).toBe(401)

    const crossTenant = await request(`/api/v1/extensions/${extension.id}/reconcile`, {
      method: 'POST',
      headers: { cookie: b.sessionCookie },
    })
    expect(crossTenant.status).toBe(404)
  })

  it('is reachable with a tenant API key too (useful for CI: push then reconcile immediately)', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)
    const res = await request(`/api/v1/extensions/${extension.id}/reconcile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.status).toBe(200)
  })
})
