import type { TargetLifecycle } from './api'
import { TriangleAlert } from 'lucide-react'

// One value per cell: the head of the pipeline, falling back to live only
// when the pipeline is empty — error > in review > queued > live. A queued
// row behind an in_review one is just waiting its turn (the review is the
// head), but a queued row alone IS the head: something is trying to go out
// and hasn't. It's usually seconds-long (push → immediate submit → in
// review); when it lingers there's always a reason (AMO rate limit, Safari
// waiting for its binary) carried in statusDetail, shown on hover. Amber
// marks "in the pipeline" — same semantic color the Versions matrix uses;
// the live version during a review is one click away on the detail page.
function LifecycleLine({ lifecycle }: { lifecycle: TargetLifecycle }) {
  if (lifecycle.status === 'error') {
    return (
      <span
        className="inline-flex items-center gap-1 text-sm font-semibold text-red-600 dark:text-red-400"
        title={lifecycle.statusDetail ?? undefined}
      >
        <TriangleAlert size={13} /> error
      </span>
    )
  }
  if (lifecycle.inReviewVersion) {
    return (
      <span className="text-sm font-semibold text-amber-600 dark:text-amber-500" title="in review">
        {lifecycle.inReviewVersion}
      </span>
    )
  }
  if (lifecycle.queuedVersion) {
    return (
      <span
        className="text-sm font-semibold text-amber-600/70 dark:text-amber-500/70"
        title={lifecycle.statusDetail ?? 'queued'}
      >
        {lifecycle.queuedVersion}
      </span>
    )
  }
  if (lifecycle.liveVersion) {
    return (
      <span className="text-sm font-semibold text-green-700 dark:text-green-500" title="live">
        {lifecycle.liveVersion}
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
            <span className="rounded bg-muted px-1 py-px font-mono text-[10px] text-muted-foreground">{lifecycle.platform}</span>
          )}
          <LifecycleLine lifecycle={lifecycle} />
        </span>
      ))}
    </span>
  )
}
