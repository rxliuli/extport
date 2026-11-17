import type { TargetLifecycle } from './api'
import { TriangleAlert } from 'lucide-react'

// One line per lifecycle, readable without a legend: a status dot plus the
// versions that matter. Precedence matches the pipeline head — error >
// rejected > in review > queued > live — and the live version stays visible
// next to whatever is pending, so "what are users running" is never hidden
// behind "what's waiting". statusDetail (rate limits, rejection notes) is on
// hover; the Extensions page spells it out in its needs-action list.
const DOT = {
  live: 'bg-green-600 dark:bg-green-400',
  pending: 'bg-amber-500 dark:bg-amber-400',
  queued: 'bg-amber-500/50 dark:bg-amber-400/50',
  bad: 'bg-red-600 dark:bg-red-400',
}

function Dot({ tone }: { tone: keyof typeof DOT }) {
  return <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOT[tone]}`} />
}

/** A single lifecycle — one store, or one Safari platform — as one line. */
export function VersionSummary({ lifecycle }: { lifecycle: TargetLifecycle }) {
  const live = lifecycle.liveVersion
  if (lifecycle.status === 'error') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-sm font-medium text-red-700 dark:text-red-400"
        title={lifecycle.statusDetail ?? 'publish failed'}
      >
        <TriangleAlert size={13} aria-hidden="true" />
        {live ? <span className="font-mono">{live}</span> : null}
        <span>failed</span>
      </span>
    )
  }
  if (lifecycle.status === 'rejected' && lifecycle.rejectedVersion) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-sm text-red-700 dark:text-red-400"
        title={lifecycle.statusDetail ?? 'rejected'}
      >
        <Dot tone="bad" />
        {live && <span className="font-mono text-foreground">{live}</span>}
        <span>
          · <span className="font-mono">{lifecycle.rejectedVersion}</span> rejected
        </span>
      </span>
    )
  }
  const pending = lifecycle.inReviewVersion ?? lifecycle.queuedVersion
  if (pending) {
    const inReview = lifecycle.inReviewVersion !== null
    return (
      <span
        className="inline-flex items-center gap-1.5 font-mono text-sm text-amber-700 dark:text-amber-400"
        title={inReview ? 'in review' : (lifecycle.statusDetail ?? 'queued')}
      >
        <Dot tone={inReview ? 'pending' : 'queued'} />
        {live ? `${live} → ${pending}` : pending}
      </span>
    )
  }
  if (live) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-sm" title="live">
        <Dot tone="live" />
        {live}
      </span>
    )
  }
  return <span className="text-muted-foreground/50">—</span>
}
