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
  /** Tenant setting — attempt to cancel an older in-review submission before pushing a newer one. */
  autoWithdraw: boolean
  /** Whether this store's adapter implements withdraw() at all. */
  canWithdraw: boolean
}

export type Decision =
  | { action: 'noop'; status: DeploymentStatus }
  | { action: 'submit'; version: string }
  | { action: 'withdraw_then_submit'; version: string }
  | { action: 'blocked' }

/**
 * Pure decision core — Appendix A's reconciliation pseudocode, with the
 * merge step split out (see mergeState) and an explicit branch for "the
 * exact version we wanted got rejected" (Appendix A's state machine has a
 * `rejected` terminal that the original pseudocode didn't spell out).
 */
export function decide(input: DecideInput): Decision {
  const { desiredVersion, merged, reviewStatus, autoWithdraw, canWithdraw } = input

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
    if (autoWithdraw && canWithdraw) return { action: 'withdraw_then_submit', version: desiredVersion }
    return { action: 'blocked' }
  }

  return { action: 'submit', version: desiredVersion }
}
