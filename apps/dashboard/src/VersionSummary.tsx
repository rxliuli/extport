import type { DeploymentStatus } from './api'
import { ageDays } from './status'

interface Target {
  status: DeploymentStatus
  liveVersion: string | null
  inReviewVersion: string | null
  queuedVersion: string | null
  rejectedVersion: string | null
  statusDetail: string | null
  submittedAt: string | null
}

const FACT_COLOR = {
  live: '#1a7f37',
  in_review: '#9a6700',
  queued: '#9a6700',
  rejected: '#cf222e',
}

// Up to three versions can be true for a target at once (live, in review,
// queued) — this renders every one that's present with its own label instead
// of picking a single "version + status" pair, which always misdescribes
// whichever version it didn't pick (see apps/api's deriveTargetStatus).
export function VersionSummary({ target }: { target: Target }) {
  const days = ageDays(target.submittedAt)
  const facts: { key: string; label: string; version: string; color: string }[] = []
  if (target.liveVersion) facts.push({ key: 'live', label: 'live', version: target.liveVersion, color: FACT_COLOR.live })
  if (target.inReviewVersion) {
    const suffix = days !== null ? ` (${days}d)` : ''
    facts.push({ key: 'in_review', label: `in review${suffix}`, version: target.inReviewVersion, color: FACT_COLOR.in_review })
  }
  if (target.rejectedVersion) facts.push({ key: 'rejected', label: 'rejected', version: target.rejectedVersion, color: FACT_COLOR.rejected })
  if (target.queuedVersion) facts.push({ key: 'queued', label: 'queued', version: target.queuedVersion, color: FACT_COLOR.queued })

  if (facts.length === 0 && target.status !== 'error') {
    return <span style={{ color: '#aaa' }}>—</span>
  }

  return (
    <span title={target.statusDetail ?? undefined}>
      {target.status === 'error' && (
        <span style={{ color: '#cf222e', fontWeight: 600 }}>
          ⚠ error{facts.length > 0 ? ' · ' : ''}
        </span>
      )}
      {facts.map((f, i) => (
        <span key={f.key}>
          {i > 0 && ' · '}
          <span style={{ color: f.color, fontWeight: 600 }}>{f.version}</span> {f.label}
        </span>
      ))}
    </span>
  )
}
