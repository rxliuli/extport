import { maxVersion, type DeploymentStatus } from '@extport/shared'
import type { DeploymentVersion } from '../db'

export interface DerivedTargetStatus {
  /** Coarse summary — for at-a-glance color/priority only, never paired with a single version for display (see the individual fields below). */
  status: DeploymentStatus
  /** MAX version with status='online'. */
  liveVersion: string | null
  /** The version currently under review at the store, if any. */
  inReviewVersion: string | null
  /** The version waiting for its turn — only coexists with inReviewVersion when status is 'blocked'. */
  queuedVersion: string | null
  /** The most recently rejected version, only shown while nothing newer has been pushed since. */
  rejectedVersion: string | null
  statusDetail: string | null
  submittedAt: string | null
}

/**
 * The single place that turns a (extension, store)'s deployment_versions rows
 * plus its publish_targets error fields into "what's true right now" — used
 * by every route that shows current status, and by tests, so there is only
 * one derivation to get right.
 *
 * Deliberately does NOT compress to one "version + status" pair — up to three
 * versions can be simultaneously true (live, in review, queued), and picking
 * one to pair with a single status label always misdescribes the others
 * (e.g. "0.0.2 · blocked" reads as "0.0.2 is blocked" when 0.0.2 is actually
 * fine — it's the queued version that's blocked). Callers render each
 * present field with its own label instead.
 */
export function deriveTargetStatus(rows: DeploymentVersion[], lastErrorDetail: string | null): DerivedTargetStatus {
  const queued = rows.find((r) => r.status === 'queued') ?? null
  const inReview = rows.find((r) => r.status === 'in_review') ?? null
  const liveVersion = maxVersion(rows.filter((r) => r.status === 'online').map((r) => r.version))

  // Nothing active — was the last thing that happened to this target a
  // rejection with no newer push since? Keep showing that (matches the old
  // "rejected persists until a new artifact arrives" behavior).
  const mostRecentTerminal = rows
    .filter((r) => r.status === 'rejected' || r.status === 'online')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
  const rejectedVersion = !queued && !inReview && mostRecentTerminal?.status === 'rejected' ? mostRecentTerminal.version : null

  const status: DeploymentStatus = lastErrorDetail
    ? 'error'
    : queued && inReview
      ? 'blocked'
      : inReview
        ? 'in_review'
        : queued
          ? 'queued'
          : rejectedVersion
            ? 'rejected'
            : 'synced'

  return {
    status,
    liveVersion,
    inReviewVersion: inReview?.version ?? null,
    queuedVersion: queued?.version ?? null,
    rejectedVersion,
    statusDetail: lastErrorDetail ?? (rejectedVersion ? mostRecentTerminal!.statusDetail : null),
    submittedAt: inReview?.submittedAt ?? null,
  }
}
