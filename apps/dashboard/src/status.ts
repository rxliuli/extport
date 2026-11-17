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
 * Store errors arrive as "<what> failed (<status>): <store's JSON body>".
 * Turn that into one sentence a person can act on; the raw text stays
 * available behind a disclosure for when the summary isn't enough.
 */
export function summarizeStoreError(message: string): string {
  const match = /^(.*?)\s*\((\d{3})\):\s*([\s\S]*)$/.exec(message)
  if (!match) return message
  const status = Number(match[2])
  const body = match[3] ?? ''
  let inner: string | undefined
  try {
    const json = JSON.parse(body) as { error?: { message?: string }; detail?: string; message?: string }
    inner = json.error?.message ?? json.detail ?? json.message
  } catch {
    inner = /"(?:message|detail)"\s*:\s*"([^"]+)"/.exec(body)?.[1]
  }
  const what =
    status === 429
      ? 'The store rate-limited extport'
      : status === 401 || status === 403
        ? 'The store refused the credential'
        : status >= 500
          ? 'The store had a server error'
          : `The store rejected the request (${status})`
  return inner ? `${what}: ${inner}` : `${what}.`
}
