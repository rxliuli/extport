import type { TargetLifecycle } from './api'
import { ageDays } from './status'
import { TriangleAlert } from 'lucide-react'

const FACT_CLASS = {
  live: 'text-green-700 dark:text-green-500',
  in_review: 'text-amber-600 dark:text-amber-400',
  queued: 'text-amber-600 dark:text-amber-400',
  rejected: 'text-red-600 dark:text-red-400',
}

// Up to three versions can be true for a lifecycle at once (live, in
// review, queued) — this renders every one that's present with its own
// label instead of picking a single "version + status" pair, which always
// misdescribes whichever version it didn't pick (see apps/api's
// deriveTargetStatus).
function LifecycleLine({ lifecycle }: { lifecycle: TargetLifecycle }) {
  const days = ageDays(lifecycle.submittedAt)
  const facts: { key: string; label: string; version: string; className: string }[] = []
  if (lifecycle.liveVersion) facts.push({ key: 'live', label: 'live', version: lifecycle.liveVersion, className: FACT_CLASS.live })
  if (lifecycle.inReviewVersion) {
    const suffix = days !== null ? ` (${days}d)` : ''
    facts.push({ key: 'in_review', label: `in review${suffix}`, version: lifecycle.inReviewVersion, className: FACT_CLASS.in_review })
  }
  if (lifecycle.rejectedVersion)
    facts.push({ key: 'rejected', label: 'rejected', version: lifecycle.rejectedVersion, className: FACT_CLASS.rejected })
  if (lifecycle.queuedVersion)
    facts.push({ key: 'queued', label: 'queued', version: lifecycle.queuedVersion, className: FACT_CLASS.queued })

  if (facts.length === 0 && lifecycle.status !== 'error') {
    return <span className="text-muted-foreground/50">—</span>
  }

  return (
    <span className="text-sm" title={lifecycle.statusDetail ?? undefined}>
      {lifecycle.status === 'error' && (
        <span className="mr-1 inline-flex items-center gap-1 font-semibold text-red-600 dark:text-red-400">
          <TriangleAlert size={13} /> error{facts.length > 0 ? ' ·' : ''}
        </span>
      )}
      {facts.map((f, i) => (
        <span key={f.key} className="whitespace-nowrap">
          {i > 0 && <span className="text-muted-foreground/60"> · </span>}
          <span className={`font-semibold ${f.className}`}>{f.version}</span>{' '}
          <span className="text-muted-foreground">{f.label}</span>
        </span>
      ))}
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
