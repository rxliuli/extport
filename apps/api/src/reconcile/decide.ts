export interface DecideInput {
  /** Is there a deployment_versions row with status='queued' for this (extension, store)? */
  hasQueued: boolean
  /** Is there still an active (unresolved) in_review row, after this tick's resolve step? */
  stillInReview: boolean
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
 */
export function decide({ hasQueued, stillInReview }: DecideInput): Decision {
  if (!hasQueued) return { action: 'noop' }
  if (stillInReview) return { action: 'wait' }
  return { action: 'submit' }
}
