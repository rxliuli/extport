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

function LifecycleLine({ lifecycle }: { lifecycle: TargetLifecycle }) {
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

// iOS before macOS: on iOS every browser is WebKit and extensions exist
// only through Safari, so that's where Safari-extension users actually
// live — macOS Safari competes with Chrome/Firefox for a far smaller
// share. Display-level order only; adapters and reconcile are untouched.
const PLATFORM_ORDER: Record<string, number> = { ios: 0, macos: 1 }

/**
 * A target's lifecycles on a single row (uniform table row heights even
 * when Safari carries two platforms). Single-lifecycle stores render
 * exactly as before; Safari platforms each get a small label.
 */
export function VersionSummary({ lifecycles }: { lifecycles: TargetLifecycle[] }) {
  if (lifecycles.length === 0) return <span className="text-muted-foreground/50">—</span>
  const ordered = [...lifecycles].sort(
    (a, b) => (PLATFORM_ORDER[a.platform ?? ''] ?? 9) - (PLATFORM_ORDER[b.platform ?? ''] ?? 9),
  )
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-0.5">
      {ordered.map((lifecycle) => (
        <span key={lifecycle.platform ?? 'default'} className="inline-flex items-center gap-1.5">
          {lifecycle.platform && (
            <span className="text-[11px] text-muted-foreground">{lifecycle.platform === 'ios' ? 'iOS' : 'macOS'}</span>
          )}
          <LifecycleLine lifecycle={lifecycle} />
        </span>
      ))}
    </span>
  )
}
