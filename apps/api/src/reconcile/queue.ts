import { compareVersions, maxVersion, newId, type Store } from '@extport/shared'
import { getAdapter } from '@extport/store-adapters'
import { and, eq, isNull, or } from 'drizzle-orm'
import { artifacts, deploymentVersions, type Db, type DeploymentVersion } from '../db'

/** One scoped reconcile handed to the queue consumer in index.ts. */
export interface ReconcileJob {
  tenantId: string
  extensionId: string
}

/**
 * Hands a scoped reconcile to the queue consumer instead of the request's
 * own lifetime. ctx.waitUntil work is killed ~30 seconds after the response
 * goes out — far less than a submit hitting a store's bad day needs (real
 * death: Twitter Filter safari, 2026-08-13, ASC 500 storm + retry backoff) —
 * while a queue consumer invocation gets 15 minutes and redelivery on
 * failure. Enqueue failure is logged, not thrown: the request's own work
 * already succeeded, and the half-hourly sweep picks queued rows up anyway.
 */
export async function enqueueReconcile(env: Env, job: ReconcileJob): Promise<void> {
  try {
    await env.RECONCILE_QUEUE.send(job)
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: `reconcile enqueue failed: ${(err as Error).message}`, ...job }))
  }
}

/**
 * The lifecycles a push can queue into for this store: [null] for
 * single-lifecycle stores, and for multi-platform stores (Safari) every
 * platform we have EVER observed a row for. Platforms are observed facts,
 * not configuration — target-add baseline discovery and the reconcile loop
 * create the first rows for platforms the store actually ships, and pushes
 * only queue where a lifecycle is known to exist (an app that never shipped
 * iOS never accumulates phantom queued iOS rows).
 */
function knownPlatforms(store: Store, rows: DeploymentVersion[]): (string | null)[] {
  if (!getAdapter(store).platforms) return [null]
  return [...new Set(rows.map((v) => v.platform).filter((p): p is NonNullable<typeof p> => p !== null))]
}

function activeMax(rows: DeploymentVersion[], platform: string | null): string | null {
  return maxVersion(
    rows
      .filter((v) => (v.platform ?? null) === platform)
      .filter((v) => v.status === 'queued' || v.status === 'in_review' || v.status === 'online')
      .map((v) => v.version),
  )
}

/**
 * Would pushing `version` for this (extension, store) move it backward?
 * For multi-platform stores a push is a regression only if it's not newer
 * for ANY known lifecycle — platforms can legitimately sit at different
 * versions, and a push that helps even one of them is accepted (and simply
 * skipped for the others by queueLatestArtifact).
 */
export async function isVersionRegression(db: Db, extensionId: string, store: Store, version: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(deploymentVersions)
    .where(and(eq(deploymentVersions.extensionId, extensionId), eq(deploymentVersions.store, store)))
  const platforms = knownPlatforms(store, rows)
  if (platforms.length === 0) return false // no lifecycle observed yet — nothing to regress against
  return platforms.every((platform) => {
    const active = activeMax(rows, platform)
    return active !== null && compareVersions(version, active) <= 0
  })
}

/**
 * Finds the best available artifact for (extensionId, store) — the highest
 * version among store-specific and universal uploads, preferring the
 * store-specific build when both exist at the same version — and, per
 * lifecycle where it's newer than whatever's currently active, marks any
 * existing queued row as skipped and queues it.
 *
 * Safe to call any time: after a push (it'll just re-find the artifact that
 * was just uploaded), or after a store target is added, to backfill an
 * artifact that was pushed before the target existed to receive it. A no-op
 * when there's nothing newer to queue.
 */
export async function queueLatestArtifact(db: Db, tenantId: string, extensionId: string, store: Store): Promise<void> {
  const candidates = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.extensionId, extensionId), or(eq(artifacts.store, store), isNull(artifacts.store))))
  const candidateVersion = maxVersion(candidates.map((a) => a.version))
  if (!candidateVersion) return

  const artifactRow =
    candidates.find((a) => a.store === store && a.version === candidateVersion) ??
    candidates.find((a) => a.store === null && a.version === candidateVersion)!

  const rows = await db
    .select()
    .from(deploymentVersions)
    .where(and(eq(deploymentVersions.extensionId, extensionId), eq(deploymentVersions.store, store)))

  for (const platform of knownPlatforms(store, rows)) {
    const active = activeMax(rows, platform)
    if (active !== null && compareVersions(candidateVersion, active) <= 0) continue

    const staleQueued = rows.filter((v) => (v.platform ?? null) === platform && v.status === 'queued')
    for (const stale of staleQueued) {
      await db
        .update(deploymentVersions)
        .set({ status: 'skipped', statusDetail: `superseded by push of v${candidateVersion}` })
        .where(eq(deploymentVersions.id, stale.id))
    }
    await db.insert(deploymentVersions).values({
      id: newId('deploymentVersion'),
      tenantId,
      extensionId,
      store,
      platform: platform as DeploymentVersion['platform'],
      version: candidateVersion,
      artifactId: artifactRow.id,
      status: 'queued',
    })
  }
}
