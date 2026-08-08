export interface DecideInput {
  /** Is there a deployment_versions row with status='queued' for this (extension, store)? */
  hasQueued: boolean
  /** Is there still an active (unresolved) in_review row, after this tick's resolve step? */
  stillInReview: boolean
  /**
   * Does the store itself report an open review right now, whether or not we
   * have a row for it? Distinct from stillInReview on purpose: that one is our
   * bookkeeping, this one is the store's constraint. They coincide for reviews
   * extport started, and diverge for one it didn't — a maintainer editing the
   * listing by hand puts the item into review under a version we already have
   * live, and no row of ours describes it.
   */
  storeBusy: boolean
}

export type Decision = { action: 'noop' } | { action: 'wait' } | { action: 'submit' }

/**
 * Pure decision core. Deliberately knows nothing about version numbers —
 * that comparison happens once, at push time (routes/artifacts.ts), where the
 * invariant "at most one active queued row, at most one active in_review row
 * per (extension, store)" is established and maintained. By the time a tick
 * reaches here, "what to do" only depends on which of those two rows exist.
 *
 * No auto-withdraw: an in-review row is never cancelled to make room for a
 * newer queued one — that livelocks on stores whose review latency exceeds
 * the push cadence (e.g. Edge's ~week-long queue), since every tick would
 * reset the review clock and nothing would ever finish. `wait` just means
 * "the queued row stays queued" — the next tick where in_review resolves
 * (online or rejected) picks it up. A stuck review still surfaces via the
 * stale_review digest; clearing it is a deliberate human action, not a timer.
 *
 * storeBusy is checked alongside our own bookkeeping because "no upload while
 * something is in review" is the store's rule, not extport's policy — it holds
 * regardless of whether we have a row for that review. Without it, an
 * externally-started review (a listing edited by hand) made every tick upload
 * and collect the same rejection: Gmail Notifier on Chrome, 2026-08-08,
 * `400 You may not edit or publish an item that is in review`.
 */
export function decide({ hasQueued, stillInReview, storeBusy }: DecideInput): Decision {
  if (!hasQueued) return { action: 'noop' }
  if (stillInReview || storeBusy) return { action: 'wait' }
  return { action: 'submit' }
}
