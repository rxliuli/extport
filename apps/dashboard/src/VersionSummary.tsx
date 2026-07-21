import type { DeploymentStatus } from './api'
import { ageDays } from './status'
import { TriangleAlert } from 'lucide-react'

interface Target {
  status: DeploymentStatus
  liveVersion: string | null
  inReviewVersion: string | null
  queuedVersion: string | null
  rejectedVersion: string | null
  statusDetail: string | null
  submittedAt: string | null
}

const FACT_CLASS = {
  live: 'text-green-700',
  in_review: 'text-amber-600',
  queued: 'text-amber-600',
  rejected: 'text-red-600',
}

// Up to three versions can be true for a target at once (live, in review,
// queued) — this renders every one that's present with its own label instead
// of picking a single "version + status" pair, which always misdescribes
// whichever version it didn't pick (see apps/api's deriveTargetStatus).
export function VersionSummary({ target }: { target: Target }) {
  const days = ageDays(target.submittedAt)
  const facts: { key: string; label: string; version: string; className: string }[] = []
  if (target.liveVersion) facts.push({ key: 'live', label: 'live', version: target.liveVersion, className: FACT_CLASS.live })
  if (target.inReviewVersion) {
    const suffix = days !== null ? ` (${days}d)` : ''
    facts.push({ key: 'in_review', label: `in review${suffix}`, version: target.inReviewVersion, className: FACT_CLASS.in_review })
  }
  if (target.rejectedVersion)
    facts.push({ key: 'rejected', label: 'rejected', version: target.rejectedVersion, className: FACT_CLASS.rejected })
  if (target.queuedVersion) facts.push({ key: 'queued', label: 'queued', version: target.queuedVersion, className: FACT_CLASS.queued })

  if (facts.length === 0 && target.status !== 'error') {
    return <span className="text-muted-foreground/50">—</span>
  }

  return (
    <span className="text-sm" title={target.statusDetail ?? undefined}>
      {target.status === 'error' && (
        <span className="mr-1 inline-flex items-center gap-1 font-semibold text-red-600">
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
