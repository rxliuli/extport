import { compareVersions, type DeploymentStatus } from '@extport/shared'
import type { StoreState } from '@extport/store-adapters'

/** What deployment_states already remembers, going into this reconcile tick. */
export interface PriorState {
  liveVersion: string | null
  inReviewVersion: string | null
}

/** The knowledge deployment_states should carry forward, after merging this tick's observation. */
export interface MergedState {
  liveVersion: string | null
  inReviewVersion: string | null
}

/**
 * Merge a fresh store observation into what we already knew. `undefined`
 * fields in `actual` mean "this store can't tell us" (Edge) and must not
 * clobber `prior`; `null` means the store positively confirmed emptiness and
 * wins outright. See StoreState's doc comment for the full contract.
 */
export function mergeState(prior: PriorState, actual: StoreState): MergedState {
  return {
    liveVersion: actual.liveVersion === undefined ? prior.liveVersion : actual.liveVersion,
    inReviewVersion: actual.inReviewVersion === undefined ? prior.inReviewVersion : actual.inReviewVersion,
  }
}

export interface DecideInput {
  /** Latest artifact version for this (extension, store), or null if none has ever been uploaded. */
  desiredVersion: string | null
  merged: MergedState
  /** Only meaningful when it describes `merged.inReviewVersion`'s fate this tick. */
  reviewStatus?: 'pending' | 'rejected'
}

export type Decision =
  | { action: 'noop'; status: DeploymentStatus }
  | { action: 'submit'; version: string }
  | { action: 'blocked' }

/**
 * Pure decision core — Appendix A's reconciliation pseudocode, with the
 * merge step split out (see mergeState) and an explicit branch for "the
 * exact version we wanted got rejected" (Appendix A's state machine has a
 * `rejected` terminal that the original pseudocode didn't spell out).
 *
 * No auto-withdraw: an older in-review version is never cancelled to make
 * room for a newer one — that livelocks on stores whose review latency
 * exceeds the push cadence (e.g. Edge's ~week-long queue), since every tick
 * would reset the review clock and nothing would ever finish. Instead we
 * always wait (`blocked`) for the current review to resolve on its own —
 * approved or rejected — at which point the next tick picks up the latest
 * queued version. A stuck review still surfaces via the stale_review digest;
 * clearing it is a deliberate human action (manual withdraw), not a timer.
 */
export function decide(input: DecideInput): Decision {
  const { desiredVersion, merged, reviewStatus } = input

  if (!desiredVersion) return { action: 'noop', status: 'synced' }
  if (merged.liveVersion && compareVersions(desiredVersion, merged.liveVersion) <= 0) {
    return { action: 'noop', status: 'synced' }
  }

  if (merged.inReviewVersion === desiredVersion) {
    return reviewStatus === 'rejected'
      ? { action: 'noop', status: 'rejected' }
      : { action: 'noop', status: 'in_review' }
  }

  if (merged.inReviewVersion && compareVersions(merged.inReviewVersion, desiredVersion) < 0) {
    // An older version is in flight. If it was just rejected, the slot is
    // actually free — no withdrawal needed, go straight to submitting.
    if (reviewStatus === 'rejected') return { action: 'submit', version: desiredVersion }
    return { action: 'blocked' }
  }

  return { action: 'submit', version: desiredVersion }
}
