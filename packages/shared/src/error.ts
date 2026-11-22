/**
 * Store errors arrive as "<what> failed (<status>): <store's JSON body>".
 * Turn that into one sentence a person can act on; the raw text stays
 * available in D1 / behind a dashboard disclosure for when the summary
 * isn't enough.
 */
export function summarizeStoreError(message: string): string {
  const match = /^(.*?)\s*\((\d{3})\):\s*([\s\S]*)$/.exec(message)
  if (!match) return message
  const status = Number(match[2])
  const body = match[3] ?? ''
  let inner: string | undefined
  try {
    const json = JSON.parse(body) as {
      error?: { message?: string }
      errors?: { detail?: string; message?: string; title?: string }[]
      detail?: string
      message?: string
    }
    const firstErr = Array.isArray(json.errors) ? json.errors[0] : undefined
    inner =
      json.error?.message ?? firstErr?.detail ?? firstErr?.message ?? firstErr?.title ?? json.detail ?? json.message
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
