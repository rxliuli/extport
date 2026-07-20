import { encryptJson, newId, type DeploymentStatus, type Store } from '@extport/shared'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  artifacts,
  createDb,
  deploymentStates,
  extensions,
  publishEvents,
  publishTargets,
  storeCredentials,
  tenants,
} from '../src/db'
import { provisionTenantDek, tenantDek } from '../src/lib/kms'
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
  deploymentState?: {
    liveVersion?: string | null
    inReviewVersion?: string | null
    status?: DeploymentStatus
    submittedAt?: Date
  }
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

  for (const a of opts.artifacts ?? []) {
    const r2Key = `artifacts/${tenantId}/${extensionId}/${a.version}/${a.store ?? 'universal'}.zip`
    await db.insert(artifacts).values({
      id: newId('artifact'),
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
  }

  if (opts.deploymentState) {
    await db.insert(deploymentStates).values({
      id: newId('deploymentState'),
      tenantId,
      extensionId,
      store: 'chrome',
      desiredVersion: null,
      liveVersion: opts.deploymentState.liveVersion ?? null,
      inReviewVersion: opts.deploymentState.inReviewVersion ?? null,
      status: opts.deploymentState.status ?? 'synced',
      submittedAt: opts.deploymentState.submittedAt,
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

function chromeRoutes(opts: {
  fetchStatus?: unknown
  uploadOk?: boolean
  publishOk?: boolean
  cancelOk?: boolean
} = {}): Route[] {
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

async function deploymentStateFor(db: ReturnType<typeof createDb>, extensionId: string) {
  const [row] = await db.select().from(deploymentStates).where(eq(deploymentStates.extensionId, extensionId))
  return row
}

async function eventsFor(db: ReturnType<typeof createDb>, extensionId: string) {
  return db.select().from(publishEvents).where(eq(publishEvents.extensionId, extensionId))
}

describe('runReconciliation — fresh publish', () => {
  it('submits the first artifact and records a submitted event', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({ artifacts: [{ version: '1.0.0' }] })
    const { fetch, calls } = routedFetch(chromeRoutes())
    globalThis.fetch = fetch

    const summary = await runReconciliation(env, db, { tenantId })
    expect(summary).toEqual({ processed: 1, submitted: 1, blocked: 0, errors: 0 })

    const state = await deploymentStateFor(db, extensionId)
    expect(state).toMatchObject({ status: 'in_review', inReviewVersion: '1.0.0', desiredVersion: '1.0.0' })
    expect(state!.submittedAt).not.toBeNull()

    const events = await eventsFor(db, extensionId)
    expect(events.map((e) => e.type)).toEqual(['submitted'])
    expect(calls.some((c) => c.url.endsWith(':publish'))).toBe(true)
  })
})

describe('runReconciliation — already synced', () => {
  it('does nothing and never calls upload/publish', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({
      artifacts: [{ version: '1.0.0' }],
      deploymentState: { liveVersion: '1.0.0', status: 'synced' },
    })
    const { fetch, calls } = routedFetch(
      chromeRoutes({
        fetchStatus: { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.0.0' }] } },
      }),
    )
    globalThis.fetch = fetch

    const summary = await runReconciliation(env, db, { tenantId })
    expect(summary).toEqual({ processed: 1, submitted: 0, blocked: 0, errors: 0 })
    expect(await deploymentStateFor(db, extensionId)).toMatchObject({ status: 'synced', liveVersion: '1.0.0' })
    expect(calls.some((c) => c.url.endsWith(':upload') || c.url.endsWith(':publish'))).toBe(false)
    expect(await eventsFor(db, extensionId)).toHaveLength(0)
  })
})

describe('runReconciliation — waiting on the exact version already in review', () => {
  it('stays in_review without resubmitting', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({
      artifacts: [{ version: '1.1.0' }],
      deploymentState: { inReviewVersion: '1.1.0', status: 'in_review', submittedAt: new Date() },
    })
    globalThis.fetch = routedFetch(
      chromeRoutes({
        fetchStatus: { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.1.0' }] } },
      }),
    ).fetch

    const summary = await runReconciliation(env, db, { tenantId })
    expect(summary).toEqual({ processed: 1, submitted: 0, blocked: 0, errors: 0 })
    expect(await deploymentStateFor(db, extensionId)).toMatchObject({ status: 'in_review', inReviewVersion: '1.1.0' })
  })
})

describe('runReconciliation — approval', () => {
  it('records an approved event when a pending version goes live', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({
      artifacts: [{ version: '1.1.0' }],
      deploymentState: { inReviewVersion: '1.1.0', liveVersion: null, status: 'in_review', submittedAt: new Date() },
    })
    globalThis.fetch = routedFetch(
      chromeRoutes({
        fetchStatus: { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.1.0' }] } },
      }),
    ).fetch

    await runReconciliation(env, db, { tenantId })
    expect(await deploymentStateFor(db, extensionId)).toMatchObject({ status: 'synced', liveVersion: '1.1.0' })
    const events = await eventsFor(db, extensionId)
    expect(events.map((e) => e.type)).toEqual(['approved'])
    expect(JSON.parse(events[0]!.payloadJson)).toEqual({ version: '1.1.0' })
  })
})

describe('runReconciliation — rejection frees the slot for a newer version', () => {
  it('records rejected for the old version and submits the new one in the same tick', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({
      artifacts: [{ version: '1.1.0' }, { version: '1.2.0' }],
      deploymentState: { inReviewVersion: '1.1.0', liveVersion: null, status: 'in_review', submittedAt: new Date() },
    })
    globalThis.fetch = routedFetch(
      chromeRoutes({
        fetchStatus: { submittedItemRevisionStatus: { state: 'REJECTED', distributionChannels: [{ crxVersion: '1.1.0' }] } },
      }),
    ).fetch

    const summary = await runReconciliation(env, db, { tenantId })
    expect(summary.submitted).toBe(1)
    expect(await deploymentStateFor(db, extensionId)).toMatchObject({ status: 'in_review', inReviewVersion: '1.2.0' })
    const events = await eventsFor(db, extensionId)
    expect(events.map((e) => e.type)).toEqual(['rejected', 'submitted'])
  })
})

describe('runReconciliation — blocked vs withdraw_then_submit', () => {
  const scenario = {
    artifacts: [{ version: '1.0.0' }, { version: '1.1.0' }],
    deploymentState: { inReviewVersion: '1.0.0', liveVersion: null, status: 'in_review' as const, submittedAt: new Date() },
  }
  const pendingFetchStatus = {
    submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.0.0' }] },
  }

  it('blocks when auto_withdraw is off, without calling cancelSubmission', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario({ ...scenario, settingsJson: '{"autoWithdraw":false}' })
    const { fetch, calls } = routedFetch(chromeRoutes({ fetchStatus: pendingFetchStatus }))
    globalThis.fetch = fetch

    const summary = await runReconciliation(env, db, { tenantId })
    expect(summary).toEqual({ processed: 1, submitted: 0, blocked: 1, errors: 0 })
    expect(await deploymentStateFor(db, extensionId)).toMatchObject({ status: 'blocked' })
    expect(calls.some((c) => c.url.endsWith(':cancelSubmission'))).toBe(false)
  })

  it('withdraws the older version then submits the newer one when auto_withdraw is on (default)', async () => {
    const { db, tenantId, extensionId } = await setupChromeScenario(scenario)
    globalThis.fetch = routedFetch(chromeRoutes({ fetchStatus: pendingFetchStatus })).fetch

    const summary = await runReconciliation(env, db, { tenantId })
    expect(summary.submitted).toBe(1)
    expect(await deploymentStateFor(db, extensionId)).toMatchObject({ status: 'in_review', inReviewVersion: '1.1.0' })
    const events = await eventsFor(db, extensionId)
    expect(events.map((e) => e.type)).toEqual(['withdrawn', 'submitted'])
  })
})

describe('runReconciliation — failure isolation', () => {
  it('marks an invalid credential as error without any network call, and does not affect other tenants', async () => {
    const bad = await setupChromeScenario({ artifacts: [{ version: '1.0.0' }], credentialStatus: 'invalid' })
    const good = await setupChromeScenario({ artifacts: [{ version: '1.0.0' }] })
    globalThis.fetch = routedFetch(chromeRoutes()).fetch

    // No tenant filter — simulates a real cron sweep across everyone. Other
    // test files' leftover rows share this file's D1 storage (isolation is
    // per-file, not per-test, in this harness), so assertions below are
    // scoped to these two extensions rather than global summary totals.
    await runReconciliation(env, good.db, {})

    expect(await deploymentStateFor(good.db, bad.extensionId)).toMatchObject({ status: 'error' })
    expect((await eventsFor(good.db, bad.extensionId))[0]).toMatchObject({ type: 'error' })
    expect(await deploymentStateFor(good.db, good.extensionId)).toMatchObject({ status: 'in_review' })
  })

  it('reports a missing R2 object as an error without crashing the whole tick', async () => {
    const { db, tenantId, extensionId, targetId } = await setupChromeScenario({})
    // Insert an artifact row whose R2 object was never actually written.
    await db.insert(artifacts).values({
      id: newId('artifact'),
      tenantId,
      extensionId,
      version: '1.0.0',
      store: null,
      source: 'cli_upload',
      r2Key: 'artifacts/does/not/exist.zip',
      sha256: 'b'.repeat(64),
      size: 4,
    })
    globalThis.fetch = routedFetch(chromeRoutes()).fetch

    const summary = await runReconciliation(env, db, { tenantId })
    expect(summary).toEqual({ processed: 1, submitted: 0, blocked: 0, errors: 1 })
    const state = await deploymentStateFor(db, extensionId)
    expect(state?.status).toBe('error')
    expect(state?.statusDetail).toMatch(/missing from R2/)
    void targetId
  })
})

describe('POST /v1/extensions/:id/reconcile — manual trigger', () => {
  it('reconciles just the requested extension and returns a summary', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    // No publish target configured — reconcile should be a safe no-op (0 processed), not an error.
    const res = await request(`/v1/extensions/${extension.id}/reconcile`, {
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

    expect((await request(`/v1/extensions/${extension.id}/reconcile`, { method: 'POST' })).status).toBe(401)

    const crossTenant = await request(`/v1/extensions/${extension.id}/reconcile`, {
      method: 'POST',
      headers: { cookie: b.sessionCookie },
    })
    expect(crossTenant.status).toBe(404)
  })

  it('is reachable with a tenant API key too (useful for CI: push then reconcile immediately)', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const extension = await createExtension(sessionCookie)
    const key = await createApiKey(sessionCookie)
    const res = await request(`/v1/extensions/${extension.id}/reconcile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.status).toBe(200)
  })
})
