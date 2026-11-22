export { summarizeStoreError } from '@extport/shared'

/** Absolute dates render as local-time YYYY-MM-DD everywhere — never the locale-dependent M/D/YYYY. */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function ageDays(since: string | null, now: number = Date.now()): number | null {
  if (!since) return null
  return Math.floor((now - new Date(since).getTime()) / 86_400_000)
}

export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Time since an ISO date in the largest whole unit: "less than an hour",
 * "5 hours", "1 day", "6 days". Hours below a day so a review submitted
 * yesterday evening doesn't read as "since today".
 */
export function formatElapsed(since: string, now: number = Date.now()): string {
  const hours = Math.floor((now - new Date(since).getTime()) / 3_600_000)
  if (hours < 1) return 'less than an hour'
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day' : `${days} days`
}
