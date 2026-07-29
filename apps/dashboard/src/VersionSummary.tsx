import type { TargetLifecycle } from './api'
import { TriangleAlert } from 'lucide-react'

// Store targets is "what's live right now, and is anything broken" —
// in_review/queued/rejected duplicate the Versions matrix below (which has
// full history plus hover detail for every fact), so they're not repeated
// here. error replaces the live version entirely rather than sitting next to
// it: it's blocking and needs attention, unlike live/in_review/queued, which
// are just states passing through their normal flow. The live version isn't
// lost — it's still in the matrix a scroll away.
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
  if (!lifecycle.liveVersion) {
    return <span className="text-muted-foreground/50">—</span>
  }
  return (
    <span className="text-sm font-semibold text-green-700 dark:text-green-500" title="live">
      {lifecycle.liveVersion}
    </span>
  )
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
