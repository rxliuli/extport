import {
  decryptJson,
  DEFAULT_STALE_REVIEW_DAYS,
  maxVersion,
  newId,
  type DeploymentStatus,
  type PublishEventType,
  type Store,
} from '@extport/shared'
import { getAdapter } from '@extport/store-adapters'
import { and, eq, gt, inArray } from 'drizzle-orm'
import {
  artifacts,
  deploymentStates,
  extensions,
  publishEvents,
  publishTargets,
  storeCredentials,
  tenants,
  type Artifact,
  type DeploymentState,
  type Extension,
  type PublishTarget,
  type StoreCredential,
  type Tenant,
} from '../db'
import type { Db } from '../db'
import { tenantDek } from '../lib/kms'
import { createEmailNotifier, type Notifier } from '../lib/notify'
import { parseTenantSettings } from '../lib/tenant-settings'
import { decide, mergeState, type PriorState } from './decide'

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
  deploymentState: DeploymentState | null
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

function resolveDesiredVersion(extensionArtifacts: Artifact[], store: Store): string | null {
  const candidates = extensionArtifacts
    .filter((a) => a.store === store || a.store === null)
    .map((a) => a.version)
  return maxVersion(candidates)
}

function resolveArtifact(extensionArtifacts: Artifact[], store: Store, version: string): Artifact | undefined {
  // Prefer a store-specific build over the universal one when both exist at this exact version.
  return (
    extensionArtifacts.find((a) => a.store === store && a.version === version) ??
    extensionArtifacts.find((a) => a.store === null && a.version === version)
  )
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
  apple: 'App Store',
}

/**
 * Maps a publish_event into an email — spec §3.5's three priority tiers all
 * end up as an email (there's only one channel for now, see project notes);
 * the tiers just differ in framing. `withdrawn` is audit-trail only, not
 * notify-worthy on its own — it's always immediately followed by a
 * `submitted` event in the same tick, which does notify.
 */
function buildMessage(
  row: JoinedRow,
  type: PublishEventType,
  payload: Record<string, unknown>,
): { subject: string; text: string } | null {
  const ext = row.extension.name
  const store = STORE_LABELS[row.target.store]
  switch (type) {
    case 'rejected': {
      const reason =
        typeof payload.reason === 'string' && payload.reason
          ? payload.reason
          : 'No reason was provided by the store — check its developer dashboard.'
      return { subject: `❌ ${ext} rejected on ${store}`, text: `${ext} v${payload.version ?? '?'} was rejected on ${store}.\n\n${reason}` }
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
    case 'stale_review':
      return {
        subject: `⏳ ${ext} still ${payload.status} on ${store} (${payload.ageDays}+ days)`,
        text: `${ext} has been ${payload.status} on ${store} for ${payload.ageDays}+ days — this may need manual attention. Check the store's developer dashboard.`,
      }
    case 'withdrawn':
      return null
    case 'blocked':
      // Audit-trail only — waiting behind an in-review version is the normal,
      // no-action-needed steady state now (see decide.ts), not worth an email.
      // The stale_review digest is the actual signal for "this needs a look."
      return null
  }
}

async function recordEvent(
  db: Db,
  notifier: Notifier,
  row: JoinedRow,
  type: PublishEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(publishEvents).values({
    id: newId('publishEvent'),
    tenantId: row.extension.tenantId,
    extensionId: row.extension.id,
    store: row.target.store,
    type,
    payloadJson: JSON.stringify(payload),
  })
  const message = buildMessage(row, type, payload)
  if (message) await notifier.send({ to: row.tenant.email, ...message })
}

interface StatePatch {
  desiredVersion: string | null
  liveVersion: string | null
  inReviewVersion: string | null
  status: DeploymentStatus
  statusDetail: string | null
  submittedAt?: Date
}

async function upsertDeploymentState(db: Db, row: JoinedRow, patch: StatePatch): Promise<void> {
  const now = new Date()
  await db
    .insert(deploymentStates)
    .values({
      id: newId('deploymentState'),
      tenantId: row.extension.tenantId,
      extensionId: row.extension.id,
      store: row.target.store,
      desiredVersion: patch.desiredVersion,
      liveVersion: patch.liveVersion,
      inReviewVersion: patch.inReviewVersion,
      status: patch.status,
      statusDetail: patch.statusDetail,
      lastReconciledAt: now,
      submittedAt: patch.submittedAt,
    })
    .onConflictDoUpdate({
      target: [deploymentStates.extensionId, deploymentStates.store],
      set: {
        desiredVersion: patch.desiredVersion,
        liveVersion: patch.liveVersion,
        inReviewVersion: patch.inReviewVersion,
        status: patch.status,
        statusDetail: patch.statusDetail,
        lastReconciledAt: now,
        ...(patch.submittedAt ? { submittedAt: patch.submittedAt } : {}),
      },
    })
}

async function persistError(db: Db, notifier: Notifier, row: JoinedRow, message: string): Promise<void> {
  const prior = row.deploymentState
  const detail = truncate(message)
  await upsertDeploymentState(db, row, {
    desiredVersion: prior?.desiredVersion ?? null,
    liveVersion: prior?.liveVersion ?? null,
    inReviewVersion: prior?.inReviewVersion ?? null,
    status: 'error',
    statusDetail: detail,
  })
  await recordEvent(db, notifier, row, 'error', { message: detail })
}

function staleReviewThresholdDays(tenant: Tenant, store: Store): number {
  const settings = parseTenantSettings(tenant.settingsJson)
  return settings.staleReviewDays?.[store] ?? DEFAULT_STALE_REVIEW_DAYS[store]
}

async function maybeEmitStaleReview(
  db: Db,
  notifier: Notifier,
  row: JoinedRow,
  status: DeploymentStatus,
  submittedAt: Date | null,
): Promise<void> {
  if ((status !== 'in_review' && status !== 'blocked') || !submittedAt) return
  const thresholdMs = staleReviewThresholdDays(row.tenant, row.target.store) * 24 * 60 * 60 * 1000
  const ageMs = Date.now() - submittedAt.getTime()
  if (ageMs < thresholdMs) return

  const recent = await db
    .select({ id: publishEvents.id })
    .from(publishEvents)
    .where(
      and(
        eq(publishEvents.extensionId, row.extension.id),
        eq(publishEvents.store, row.target.store),
        eq(publishEvents.type, 'stale_review'),
        gt(publishEvents.createdAt, new Date(Date.now() - STALE_REVIEW_DEDUPE_MS)),
      ),
    )
    .limit(1)
  if (recent.length > 0) return

  await recordEvent(db, notifier, row, 'stale_review', { ageDays: Math.floor(ageMs / 86_400_000), status })
}

/** Emits approved/rejected events by comparing this tick's merged state against what deployment_states already had. */
async function recordTransitionEvents(
  db: Db,
  notifier: Notifier,
  row: JoinedRow,
  merged: { liveVersion: string | null; inReviewVersion: string | null },
  reviewStatus: 'pending' | 'rejected' | undefined,
  rejectionReason: string | undefined,
): Promise<void> {
  const prior = row.deploymentState
  if (merged.liveVersion && merged.liveVersion !== (prior?.liveVersion ?? null)) {
    await recordEvent(db, notifier, row, 'approved', { version: merged.liveVersion })
  }
  if (reviewStatus === 'rejected' && prior?.status !== 'rejected') {
    await recordEvent(db, notifier, row, 'rejected', { version: prior?.inReviewVersion ?? null, reason: rejectionReason })
  }
}

/**
 * One (extension, store) target through a full reconcile tick. Throws on any
 * failure — the caller catches per-target and persists the error uniformly,
 * so a bad target never takes its siblings down with it.
 */
async function reconcileOne(
  env: Env,
  db: Db,
  notifier: Notifier,
  row: JoinedRow,
  credentials: unknown,
  extensionArtifacts: Artifact[],
): Promise<'noop' | 'submitted' | 'blocked'> {
  const { target } = row
  const adapter = getAdapter(target.store)
  const prior: PriorState = {
    liveVersion: row.deploymentState?.liveVersion ?? null,
    inReviewVersion: row.deploymentState?.inReviewVersion ?? null,
  }

  const desiredVersion = resolveDesiredVersion(extensionArtifacts, target.store)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- credentials are opaque per-store, validated at save time
  const actual = await adapter.getState(credentials as any, target.storeItemId)
  const merged = mergeState(prior, actual)

  // Reflect anything the store told us this tick (a version going live, a
  // rejection) before deciding what to do next — these can fire alongside a
  // submit, e.g. v1.1 just got approved AND v1.2 is ready to go out.
  await recordTransitionEvents(db, notifier, row, merged, actual.reviewStatus, actual.rejectionReason)

  const decision = decide({ desiredVersion, merged, reviewStatus: actual.reviewStatus })

  if (decision.action === 'noop') {
    await upsertDeploymentState(db, row, {
      desiredVersion,
      liveVersion: merged.liveVersion,
      inReviewVersion: merged.inReviewVersion,
      status: decision.status,
      statusDetail: decision.status === 'rejected' ? (actual.rejectionReason ?? null) : null,
    })
    await maybeEmitStaleReview(db, notifier, row, decision.status, row.deploymentState?.submittedAt ?? null)
    return 'noop'
  }

  if (decision.action === 'blocked') {
    // Only record entering the state, not every tick it stays blocked —
    // this is the normal steady state while a review is in flight.
    if (row.deploymentState?.status !== 'blocked') {
      await recordEvent(db, notifier, row, 'blocked', { desiredVersion, inReviewVersion: merged.inReviewVersion })
    }
    await upsertDeploymentState(db, row, {
      desiredVersion,
      liveVersion: merged.liveVersion,
      inReviewVersion: merged.inReviewVersion,
      status: 'blocked',
      statusDetail: null,
    })
    await maybeEmitStaleReview(db, notifier, row, 'blocked', row.deploymentState?.submittedAt ?? null)
    return 'blocked'
  }

  const version = decision.version
  const artifactRow = resolveArtifact(extensionArtifacts, target.store, version)
  if (!artifactRow) {
    throw new Error(`no artifact found for ${target.store} v${version} — it may have been deleted`)
  }
  const object = await env.ARTIFACTS.get(artifactRow.r2Key)
  if (!object) throw new Error(`artifact object missing from R2: ${artifactRow.r2Key}`)
  const bytes = await object.arrayBuffer()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await adapter.submit(credentials as any, target.storeItemId, bytes)
  if (!result.submitted) {
    throw new Error(result.detail ?? `${target.store} submit failed without a detail message`)
  }

  await upsertDeploymentState(db, row, {
    desiredVersion,
    liveVersion: merged.liveVersion,
    inReviewVersion: version,
    status: 'in_review',
    statusDetail: result.detail ?? null,
    submittedAt: new Date(),
  })
  await recordEvent(db, notifier, row, 'submitted', { version, detail: result.detail })
  return 'submitted'
}

/**
 * The reconciliation loop (spec Appendix A). Runs from a Cron Trigger every
 * 30 minutes with no filter, or scoped to one tenant/extension from the
 * dashboard's manual "reconcile now" button.
 */
export async function runReconciliation(
  env: Env,
  db: Db,
  filter: ReconcileFilter = {},
  notifier: Notifier = createEmailNotifier(env),
): Promise<ReconcileSummary> {
  const conditions = [eq(extensions.publishingEnabled, true), eq(publishTargets.enabled, true)]
  if (filter.tenantId) conditions.push(eq(extensions.tenantId, filter.tenantId))
  if (filter.extensionId) conditions.push(eq(publishTargets.extensionId, filter.extensionId))

  const rows: JoinedRow[] = await db
    .select({
      target: publishTargets,
      extension: extensions,
      credential: storeCredentials,
      tenant: tenants,
      deploymentState: deploymentStates,
    })
    .from(publishTargets)
    .innerJoin(extensions, eq(publishTargets.extensionId, extensions.id))
    .innerJoin(storeCredentials, eq(publishTargets.credentialId, storeCredentials.id))
    .innerJoin(tenants, eq(extensions.tenantId, tenants.id))
    .leftJoin(
      deploymentStates,
      and(eq(deploymentStates.extensionId, publishTargets.extensionId), eq(deploymentStates.store, publishTargets.store)),
    )
    .where(and(...conditions))

  const summary: ReconcileSummary = { processed: 0, submitted: 0, blocked: 0, errors: 0 }
  if (rows.length === 0) return summary

  const extensionIds = [...new Set(rows.map((r) => r.extension.id))]
  const artifactRows = await db.select().from(artifacts).where(inArray(artifacts.extensionId, extensionIds))
  const artifactsByExtension = new Map<string, Artifact[]>()
  for (const a of artifactRows) {
    const list = artifactsByExtension.get(a.extensionId)
    if (list) list.push(a)
    else artifactsByExtension.set(a.extensionId, [a])
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
        const outcome = await reconcileOne(env, db, notifier, row, credentials, artifactsByExtension.get(row.extension.id) ?? [])
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
