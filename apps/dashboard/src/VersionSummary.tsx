import type { TargetLifecycle } from './api'
import { TriangleAlert } from 'lucide-react'

// One value per cell, by what deserves attention: error > in review > live,
// with queued as a last resort so a brand-new target (first review pending,
// nothing live yet) doesn't render as an empty dash. Amber marks "in the
// pipeline" — same semantic color the Versions matrix uses; the live version
// during a review is one click away on the detail page.
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
  if (lifecycle.liveVersion) {
    return (
      <span className="text-sm font-semibold text-green-700 dark:text-green-500" title="live">
        {lifecycle.liveVersion}
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
  return <span className="text-muted-foreground/50">—</span>
}

/**
 * A target's lifecycles, one line each. Single-lifecycle stores render
 * exactly as before; Safari gets one line per platform with a small label.
 */
export function VersionSummary({ lifecycles }: { lifecycles: TargetLifecycle[] }) {
  if (lifecycles.length === 0) return <span className="text-muted-foreground/50">—</span>
  return (
    <span className="inline-flex flex-col gap-0.5">
      {lifecycles.map((lifecycle) => (
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
