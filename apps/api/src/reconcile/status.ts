import { maxVersion, type DeploymentStatus } from '@extport/shared'
import type { DeploymentVersion } from '../db'

export interface DerivedTargetStatus {
  status: DeploymentStatus
  /** The version `status` is actually describing — always pair these two together when rendering. */
  version: string | null
  /** MAX version currently live — shown as ambient context even when `version` describes something else (e.g. still serving 0.0.1 while 0.0.2 is in review). */
  liveVersion: string | null
  /** Only set when `status` is 'blocked': the version waiting behind `version`, which is what's actually in review. */
  queuedVersion: string | null
  statusDetail: string | null
  submittedAt: Date | null
}

/**
 * The single place that turns a (extension, store)'s deployment_versions rows
 * plus its publish_targets error fields into "what's true right now" — used
 * by every route that shows current status, and by tests, so there is only
 * one derivation to get right.
 *
 * `version` is deliberately whichever version `status` is actually about —
 * pairing "0.0.1 · in review" (the live version, next to a status that
 * describes a completely different one) reads as a lie, not a summary.
 */
export function deriveTargetStatus(rows: DeploymentVersion[], lastErrorDetail: string | null): DerivedTargetStatus {
  const queued = rows.find((r) => r.status === 'queued') ?? null
  const inReview = rows.find((r) => r.status === 'in_review') ?? null
  const liveVersion = maxVersion(rows.filter((r) => r.status === 'online').map((r) => r.version))

  if (lastErrorDetail) {
    return { status: 'error', version: liveVersion, liveVersion, queuedVersion: null, statusDetail: lastErrorDetail, submittedAt: inReview?.submittedAt ?? null }
  }

  if (queued && inReview) {
    return { status: 'blocked', version: inReview.version, liveVersion, queuedVersion: queued.version, statusDetail: null, submittedAt: inReview.submittedAt }
  }
  if (inReview) {
    return { status: 'in_review', version: inReview.version, liveVersion, queuedVersion: null, statusDetail: null, submittedAt: inReview.submittedAt }
  }
  if (queued) {
    return { status: 'queued', version: queued.version, liveVersion, queuedVersion: null, statusDetail: null, submittedAt: null }
  }

  // Nothing active — if the last thing that happened to this target was a
  // rejection with no newer push since, keep showing that (matches the old
  // "rejected persists until a new artifact arrives" behavior).
  const mostRecentTerminal = rows
    .filter((r) => r.status === 'rejected' || r.status === 'online')
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
  if (mostRecentTerminal?.status === 'rejected') {
    return {
      status: 'rejected',
      version: mostRecentTerminal.version,
      liveVersion,
      queuedVersion: null,
      statusDetail: mostRecentTerminal.statusDetail,
      submittedAt: mostRecentTerminal.submittedAt,
    }
  }
  return { status: 'synced', version: liveVersion, liveVersion, queuedVersion: null, statusDetail: null, submittedAt: null }
}
