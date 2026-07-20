import type { DeploymentStatus } from './api'

// synced 绿 / in_review 黄 / rejected 红 / blocked 灰 / error 红 (spec §3.6)
export const STATUS_COLOR: Record<DeploymentStatus, string> = {
  synced: '#1a7f37',
  submitting: '#9a6700',
  in_review: '#9a6700',
  rejected: '#cf222e',
  blocked: '#6e7781',
  error: '#cf222e',
}

export const STATUS_LABEL: Record<DeploymentStatus, string> = {
  synced: 'synced',
  submitting: 'submitting',
  in_review: 'in review',
  rejected: 'rejected',
  blocked: 'blocked',
  error: 'error',
}

export function ageDays(since: string | null): number | null {
  if (!since) return null
  return Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000)
}
