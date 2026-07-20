import { compareVersions, maxVersion, newId, type Store } from '@extport/shared'
import { and, eq, isNull, or } from 'drizzle-orm'
import { artifacts, deploymentVersions, type Db } from '../db'

/** Every status that currently "counts" — a version queued, submitted, or already live. */
async function activeMaxVersion(db: Db, extensionId: string, store: Store): Promise<string | null> {
  const rows = await db.select().from(deploymentVersions).where(and(eq(deploymentVersions.extensionId, extensionId), eq(deploymentVersions.store, store)))
  return maxVersion(rows.filter((v) => v.status === 'queued' || v.status === 'in_review' || v.status === 'online').map((v) => v.version))
}

/** Would pushing `version` for this (extension, store) move it backward relative to what's already queued/in review/live? */
export async function isVersionRegression(db: Db, extensionId: string, store: Store, version: string): Promise<boolean> {
  const active = await activeMaxVersion(db, extensionId, store)
  return active !== null && compareVersions(version, active) <= 0
}

/**
 * Finds the best available artifact for (extensionId, store) — the highest
 * version among store-specific and universal uploads, preferring the
 * store-specific build when both exist at the same version — and, if it's
 * newer than whatever's currently active, marks any existing queued row as
 * skipped and queues it.
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

  const active = await activeMaxVersion(db, extensionId, store)
  if (active !== null && compareVersions(candidateVersion, active) <= 0) return

  const artifactRow =
    candidates.find((a) => a.store === store && a.version === candidateVersion) ??
    candidates.find((a) => a.store === null && a.version === candidateVersion)!

  await db
    .update(deploymentVersions)
    .set({ status: 'skipped', statusDetail: `superseded by push of v${candidateVersion}` })
    .where(and(eq(deploymentVersions.extensionId, extensionId), eq(deploymentVersions.store, store), eq(deploymentVersions.status, 'queued')))
  await db.insert(deploymentVersions).values({
    id: newId('deploymentVersion'),
    tenantId,
    extensionId,
    store,
    version: candidateVersion,
    artifactId: artifactRow.id,
    status: 'queued',
  })
}
