import { DEFAULT_STALE_REVIEW_DAYS, decryptJson, newId, type Store } from '@extport/shared'
import { getAdapter } from '@extport/store-adapters'
import { and, desc, eq, gt, inArray } from 'drizzle-orm'
import {
  artifacts,
  deploymentVersions,
  extensions,
  publishEvents,
  publishTargets,
  storeCredentials,
  tenants,
  type DeploymentVersion,
  type Extension,
  type PublishTarget,
  type StoreCredential,
  type Tenant,
} from '../db'
import type { Db } from '../db'
import { tenantDek } from '../lib/kms'
import { createEmailNotifier, type Notifier } from '../lib/notify'
import { parseTenantSettings } from '../lib/tenant-settings'
import { decide } from './decide'

// One reconcile tick processes at most this many (tenant, store) credential
// groups at a time — bounds concurrent load on any single store's API.
// Targets within one group are processed sequentially.
const GROUP_CONCURRENCY = 5

// Dedupe window for stale_review notifications ("每日汇总一次不重复轰炸").
// Slightly under 24h so a little cron-tick drift can't create a skipped day.
const STALE_REVIEW_DEDUPE_MS = 20 * 60 * 60 * 1000

interface JoinedRow {
  target: PublishTarget
  extension: Extension
  credential: StoreCredential
  tenant: Tenant
}

export interface ReconcileFilter {
  tenantId?: string
  extensionId?: string
}

export interface ReconcileSummary {
  processed: number
  submitted: number
  blocked: number
  errors: number
}

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function groupByCredential(rows: JoinedRow[]): JoinedRow[][] {
  const groups = new Map<string, JoinedRow[]>()
  for (const row of rows) {
    const key = row.credential.id
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  return [...groups.values()]
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  async function next(): Promise<void> {
    while (index < items.length) {
      const item = items[index++]!
      await worker(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next))
}

const STORE_LABELS: Record<Store, string> = {
  chrome: 'Chrome Web Store',
  firefox: 'Firefox Add-ons',
  edge: 'Edge Add-ons',
  safari: 'App Store',
}

type NotifyKind = 'submitted' | 'approved' | 'rejected' | 'error'

/**
 * Maps a notification-worthy moment into an email. `error` and `stale_review`
 * are also persisted as publish_events; submitted/approved/rejected live only
 * as the deployment_versions row's status — the row itself is the record,
 * this is purely the side-effect of telling the tenant about it.
 */
function buildMessage(row: JoinedRow, kind: NotifyKind, payload: Record<string, unknown>): { subject: string; text: string } | null {
  const ext = row.extension.name
  const store = STORE_LABELS[row.target.store]
  switch (kind) {
    case 'rejected': {
      const reason =
        typeof payload.reason === 'string' && payload.reason
          ? payload.reason
          : 'No reason was provided by the store — check its developer dashboard.'
      return { subject: `❌ ${ext} rejected on ${store}`, text: `${ext} v${payload.version} was rejected on ${store}.\n\n${reason}` }
    }
    case 'error':
      return {
        subject: `⚠️ ${ext} publishing error on ${store}`,
        text: `${ext} hit an error while reconciling ${store}:\n\n${payload.message ?? 'unknown error'}`,
      }
    case 'approved':
      return { subject: `✅ ${ext} v${payload.version} is live on ${store}`, text: `${ext} v${payload.version} is now live on ${store}.` }
    case 'submitted':
      return {
        subject: `${ext} v${payload.version} submitted to ${store}`,
        text: `${ext} v${payload.version} was submitted for review on ${store}.${payload.detail ? `\n\n${payload.detail}` : ''}`,
      }
  }
}

async function notify(notifier: Notifier, row: JoinedRow, kind: NotifyKind, payload: Record<string, unknown>): Promise<void> {
  const message = buildMessage(row, kind, payload)
  if (message) await notifier.send({ to: row.tenant.email, ...message })
}

async function persistError(db: Db, notifier: Notifier, row: JoinedRow, message: string): Promise<void> {
  const detail = truncate(message)
  // The event and the email mark the healthy → erroring TRANSITION, not every
  // failing tick — a credential left broken for a week must not produce 48
  // identical emails a day (cron runs every 30 minutes). Same philosophy as
  // blocked/stale_review. Deliberately keyed on "was already erroring", not on
  // message equality: store API error bodies embed per-request ids (Apple puts
  // a UUID in every error response), so equality would see a "new" error every
  // tick and spam anyway. The freshest message is still always visible — the
  // target row below is updated on every failing tick.
  const isTransition = row.target.lastErrorDetail === null
  await db
    .update(publishTargets)
    .set({ lastErrorDetail: detail, lastErrorAt: new Date().toISOString() })
    .where(eq(publishTargets.id, row.target.id))
  row.target.lastErrorDetail = detail
  if (!isTransition) return

  await db.insert(publishEvents).values({
    id: newId('publishEvent'),
    tenantId: row.extension.tenantId,
    extensionId: row.extension.id,
    store: row.target.store,
    type: 'error',
    payloadJson: JSON.stringify({ message: detail }),
  })
  await notify(notifier, row, 'error', { message: detail })
}

function staleReviewThresholdDays(tenant: Tenant, store: Store): number {
  const settings = parseTenantSettings(tenant.settingsJson)
  return settings.staleReviewDays?.[store] ?? DEFAULT_STALE_REVIEW_DAYS[store]
}

async function maybeEmitStaleReview(db: Db, notifier: Notifier, row: JoinedRow, inReview: DeploymentVersion | null): Promise<void> {
  if (!inReview || !inReview.submittedAt) return
  const thresholdMs = staleReviewThresholdDays(row.tenant, row.target.store) * 24 * 60 * 60 * 1000
  const ageMs = Date.now() - new Date(inReview.submittedAt).getTime()
  if (ageMs < thresholdMs) return

  const recent = await db
    .select({ id: publishEvents.id })
    .from(publishEvents)
    .where(
      and(
        eq(publishEvents.extensionId, row.extension.id),
        eq(publishEvents.store, row.target.store),
        eq(publishEvents.type, 'stale_review'),
        gt(publishEvents.createdAt, new Date(Date.now() - STALE_REVIEW_DEDUPE_MS).toISOString()),
      ),
    )
    .limit(1)
  if (recent.length > 0) return

  const ageDays = Math.floor(ageMs / 86_400_000)
  await db.insert(publishEvents).values({
    id: newId('publishEvent'),
    tenantId: row.extension.tenantId,
    extensionId: row.extension.id,
    store: row.target.store,
    type: 'stale_review',
    payloadJson: JSON.stringify({ version: inReview.version, ageDays }),
  })
  await notifier.send({
    to: row.tenant.email,
    subject: `⏳ ${row.extension.name} still in review on ${STORE_LABELS[row.target.store]} (${ageDays}+ days)`,
    text: `${row.extension.name} v${inReview.version} has been in review on ${STORE_LABELS[row.target.store]} for ${ageDays}+ days — this may need manual attention. Check the store's developer dashboard.`,
  })
}

/**
 * One lifecycle — (extension, store, platform) — through a full reconcile
 * tick. Single-lifecycle stores pass platform=undefined; Safari runs this
 * once per platform (docs/safari-pipeline.md), each with its own queued/
 * in_review rows and its own store queries.
 */
async function reconcileLifecycle(
  env: Env,
  db: Db,
  notifier: Notifier,
  row: JoinedRow,
  credentials: unknown,
  lifecycleRows: DeploymentVersion[],
  platform: string | undefined,
): Promise<'noop' | 'submitted' | 'blocked'> {
  const { target } = row
  const adapter = getAdapter(target.store)
  const storeTarget = { storeItemId: target.storeItemId, crxId: target.crxId ?? undefined }
  const dbPlatform = (platform ?? null) as DeploymentVersion['platform']

  let queued = lifecycleRows.find((v) => v.status === 'queued') ?? null
  let inReview = lifecycleRows.find((v) => v.status === 'in_review') ?? null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- credentials are opaque per-store, validated at save time
  const actual = await adapter.getState(credentials as any, storeTarget, platform)

  // --- resolve step: reflect whatever the store told us this tick ---
  const liveReport = actual.live
  if (liveReport.known && liveReport.version) {
    const liveVersion = liveReport.version
    const alreadyRecordedOnline = lifecycleRows.some((v) => v.status === 'online' && v.version === liveVersion)
    if (!alreadyRecordedOnline) {
      if (inReview && inReview.version === liveVersion) {
        await db.update(deploymentVersions).set({ status: 'online', statusDetail: null }).where(eq(deploymentVersions.id, inReview.id))
        await notify(notifier, row, 'approved', { version: inReview.version })
        inReview = null
      } else {
        // First-ever baseline (target just added, nothing pushed through extport
        // yet) or a manual publish that happened outside extport entirely —
        // either way, reflect what the store says is actually live.
        await db.insert(deploymentVersions).values({
          id: newId('deploymentVersion'),
          tenantId: row.extension.tenantId,
          extensionId: target.extensionId,
          store: target.store,
          platform: dbPlatform,
          version: liveVersion,
          artifactId: null,
          status: 'online',
        })
      }
    }
  }
  if (inReview && actual.reviewStatus === 'rejected') {
    await db.update(deploymentVersions).set({ status: 'rejected', statusDetail: actual.rejectionReason ?? null }).where(eq(deploymentVersions.id, inReview.id))
    await notify(notifier, row, 'rejected', { version: inReview.version, reason: actual.rejectionReason })
    inReview = null
  }
  // A submission we don't have an active row for — the first-ever tick for a
  // target that already had something mid-review before extport started
  // tracking it, or a gap where our own submit succeeded at the store but the
  // write recording it never landed. Either way, reflect it so decide() waits
  // instead of submitting the queued row on top of it. submittedAt is left
  // unknown (null) rather than guessed at "now" — see maybeEmitStaleReview,
  // which already treats a null submittedAt as "can't judge staleness."
  const inReviewReport = actual.inReview
  if (!inReview && inReviewReport.known && inReviewReport.version) {
    const inReviewVersion = inReviewReport.version
    if (queued && queued.version === inReviewVersion) {
      await db.update(deploymentVersions).set({ status: 'in_review', submittedAt: null }).where(eq(deploymentVersions.id, queued.id))
      queued = null
    } else {
      await db.insert(deploymentVersions).values({
        id: newId('deploymentVersion'),
        tenantId: row.extension.tenantId,
        extensionId: target.extensionId,
        store: target.store,
        platform: dbPlatform,
        version: inReviewVersion,
        artifactId: null,
        status: 'in_review',
      })
    }
    inReview = { version: inReviewVersion, submittedAt: null } as DeploymentVersion
  }

  await maybeEmitStaleReview(db, notifier, row, inReview)

  const decision = decide({ hasQueued: !!queued, stillInReview: !!inReview })
  if (decision.action === 'noop') return 'noop'
  if (decision.action === 'wait') return 'blocked'

  if (!queued!.artifactId) throw new Error(`queued deployment_versions row ${queued!.id} has no pinned artifact`)
  const [artifactRow] = await db.select().from(artifacts).where(eq(artifacts.id, queued!.artifactId))
  if (!artifactRow) throw new Error(`artifact ${queued!.artifactId} for ${target.store} v${queued!.version} no longer exists`)
  const object = await env.ARTIFACTS.get(artifactRow.r2Key)
  if (!object) throw new Error(`artifact object missing from R2: ${artifactRow.r2Key}`)
  const bytes = await object.arrayBuffer()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await adapter.submit(credentials as any, storeTarget, bytes, queued!.version, platform)
  if (!result.submitted) {
    if (result.waiting) {
      // Not an error — e.g. Safari waiting for the tenant's macOS pipeline
      // to upload a binary, or Edge's validation outlasting the poll window.
      // Keep the row queued and surface the reason where the dashboard shows
      // details, then retry next tick.
      await db.update(deploymentVersions).set({ statusDetail: result.detail ?? null }).where(eq(deploymentVersions.id, queued!.id))
      return 'noop'
    }
    throw new Error(result.detail ?? `${target.store} submit failed without a detail message`)
  }

  await db
    .update(deploymentVersions)
    .set({ status: 'in_review', statusDetail: result.detail ?? null, submittedAt: new Date().toISOString() })
    .where(eq(deploymentVersions.id, queued!.id))
  await notify(notifier, row, 'submitted', { version: queued!.version, detail: result.detail })
  return 'submitted'
}

/**
 * One (extension, store) target through a full reconcile tick — one
 * lifecycle per adapter-declared platform (or a single unnamed one). Throws
 * on any failure — the caller catches per-target and persists the error
 * uniformly, so a bad target never takes its siblings down with it.
 */
async function reconcileOne(env: Env, db: Db, notifier: Notifier, row: JoinedRow, credentials: unknown, versionRows: DeploymentVersion[]): Promise<'noop' | 'submitted' | 'blocked'> {
  const { target } = row
  const adapter = getAdapter(target.store)
  const platforms: (string | undefined)[] = adapter.platforms ? [...adapter.platforms] : [undefined]

  let submitted = false
  let blocked = false
  let healthConfirmed = false
  for (const platform of platforms) {
    const lifecycleRows = versionRows.filter((v) => (v.platform ?? null) === (platform ?? null))
    const outcome = await reconcileLifecycle(env, db, notifier, row, credentials, lifecycleRows, platform)

    // First lifecycle got past the store call — the target itself is healthy,
    // whatever went wrong on a previous tick no longer applies. `recovered`
    // closes the story the `error` transition event opened; audit trail only,
    // no email (whoever fixed it already knows). The in-memory row is cleared
    // too so a failure later in this same tick still registers as a fresh
    // healthy → erroring transition.
    if (!healthConfirmed) {
      healthConfirmed = true
      if (target.lastErrorDetail) {
        await db.update(publishTargets).set({ lastErrorDetail: null, lastErrorAt: null }).where(eq(publishTargets.id, target.id))
        await db.insert(publishEvents).values({
          id: newId('publishEvent'),
          tenantId: row.extension.tenantId,
          extensionId: row.extension.id,
          store: target.store,
          type: 'recovered',
          payloadJson: '{}',
        })
        target.lastErrorDetail = null
      }
    }

    if (outcome === 'submitted') submitted = true
    else if (outcome === 'blocked') blocked = true
  }
  await db.update(publishTargets).set({ lastReconciledAt: new Date().toISOString() }).where(eq(publishTargets.id, target.id))

  return submitted ? 'submitted' : blocked ? 'blocked' : 'noop'
}

/**
 * The reconciliation loop. Runs from a Cron Trigger every 30 minutes with no
 * filter, scoped to one extension right after a push or a store target being
 * added, or scoped to one tenant/extension from the dashboard's manual
 * "reconcile now" button.
 */
export async function runReconciliation(env: Env, db: Db, filter: ReconcileFilter = {}, notifier: Notifier = createEmailNotifier(env)): Promise<ReconcileSummary> {
  const conditions = [eq(publishTargets.enabled, true)]
  if (filter.tenantId) conditions.push(eq(extensions.tenantId, filter.tenantId))
  if (filter.extensionId) conditions.push(eq(publishTargets.extensionId, filter.extensionId))

  const rows: JoinedRow[] = await db
    .select({ target: publishTargets, extension: extensions, credential: storeCredentials, tenant: tenants })
    .from(publishTargets)
    .innerJoin(extensions, eq(publishTargets.extensionId, extensions.id))
    .innerJoin(storeCredentials, eq(publishTargets.credentialId, storeCredentials.id))
    .innerJoin(tenants, eq(extensions.tenantId, tenants.id))
    .where(and(...conditions))

  const summary: ReconcileSummary = { processed: 0, submitted: 0, blocked: 0, errors: 0 }
  if (rows.length === 0) return summary

  const extensionIds = [...new Set(rows.map((r) => r.extension.id))]
  const versionRows = await db.select().from(deploymentVersions).where(inArray(deploymentVersions.extensionId, extensionIds))
  const versionsByExtStore = new Map<string, DeploymentVersion[]>()
  for (const v of versionRows) {
    const key = `${v.extensionId}:${v.store}`
    const list = versionsByExtStore.get(key)
    if (list) list.push(v)
    else versionsByExtStore.set(key, [v])
  }

  const groups = groupByCredential(rows)

  await runWithConcurrency(groups, GROUP_CONCURRENCY, async (group) => {
    const { tenant, credential } = group[0]!

    if (credential.status === 'invalid') {
      for (const row of group) {
        await persistError(db, notifier, row, `store credential "${credential.label}" failed verification — reverify it in Settings`)
        summary.errors++
        summary.processed++
      }
      return
    }

    let credentials: unknown
    try {
      const dek = await tenantDek(env, tenant)
      credentials = await decryptJson(dek, credential.encryptedPayload)
    } catch (err) {
      for (const row of group) {
        await persistError(db, notifier, row, `credential decryption failed: ${(err as Error).message}`)
        summary.errors++
        summary.processed++
      }
      return
    }

    for (const row of group) {
      summary.processed++
      try {
        const key = `${row.target.extensionId}:${row.target.store}`
        const outcome = await reconcileOne(env, db, notifier, row, credentials, versionsByExtStore.get(key) ?? [])
        if (outcome === 'submitted') summary.submitted++
        if (outcome === 'blocked') summary.blocked++
      } catch (err) {
        await persistError(db, notifier, row, (err as Error).message)
        summary.errors++
      }
    }
  })

  return summary
}
