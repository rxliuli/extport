/** Injectable fetch so adapters are unit-testable without network access. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

// Sized so one complete store error fits untruncated — ASC's structured
// error JSON runs ~450 chars and its "detail" sentence was the part a
// 300 cap kept eating (Redirector, 2026-08-21) — while an AMO outage
// page (full HTML document) stays bounded.
export function truncate(text: string, max = 1000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * A store API answered with a non-success status. Carries the status and the
 * store's own error code so reconcile can record them as data (see
 * TargetError) — the message is the same human/log line it always was.
 */
export class StoreApiError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'StoreApiError'
    this.status = status
    this.code = code
  }
}

/** `${what} (${status}): ${body}` — the message shape every adapter already used. */
export function storeApiError(what: string, status: number, body?: string): StoreApiError {
  const message = body === undefined ? `${what} (${status})` : `${what} (${status}): ${truncate(body)}`
  return new StoreApiError(message, status, errorCode(body))
}

/** A plain (non-waiting) submit failure from a store API response — same detail text as storeApiError's message. */
export function submitFailure(
  what: string,
  status: number,
  body: string,
): { submitted: false; detail: string; status: number; code: string | null } {
  const err = storeApiError(what, status, body)
  return { submitted: false, detail: err.message, status, code: err.code }
}

// Best effort across the stores' error bodies: ASC/JSON:API `errors[0].code`,
// Google APIs `error.status`, OAuth `error` (a string), plain `code`.
function errorCode(body: string | undefined): string | null {
  if (!body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as { errors?: { code?: unknown }[]; error?: unknown; code?: unknown }
  const candidates = [
    Array.isArray(p.errors) ? p.errors[0]?.code : undefined,
    p.error && typeof p.error === 'object' ? (p.error as { status?: unknown }).status : p.error,
    p.code,
  ]
  const code = candidates.find((c) => typeof c === 'string' && c.length > 0 && c.length <= 64)
  return (code as string | undefined) ?? null
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RetryOptions {
  attempts: number
  baseDelayMs: number
}

export const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 500 }

/**
 * Wraps a fetch implementation so a transient 5xx gets a few short-backoff
 * retries before the caller ever sees it — a single reconcile tick can fire
 * a dozen-plus sequential calls at one store API under one credential (e.g.
 * every Safari target's macOS+iOS versions lookup), and Apple's App Store
 * Connect in particular is known to blip under that kind of burst. Never
 * retries a 4xx (a real problem a retry can't fix) or a network-level throw
 * (fetch already failed outright — surface it immediately).
 */
export function fetchWithRetry(fetchImpl: FetchLike, options: RetryOptions = DEFAULT_RETRY): FetchLike {
  return async (input, init) => {
    let res: Response
    for (let attempt = 0; ; attempt++) {
      res = await fetchImpl(input, init)
      if (res.status < 500 || attempt === options.attempts - 1) return res
      await sleep(options.baseDelayMs * 2 ** attempt)
    }
  }
}

/**
 * Poll `fn` until it returns non-null or the attempt budget runs out.
 * Used for Firefox upload validation and Edge package/operation checks —
 * both stores process asynchronously but have no webhook, so a short bounded
 * poll (a few seconds, well under Workers CPU limits since we're waiting on
 * I/O) resolves same-tick when the store is fast, and falls through to "try
 * again next reconcile tick" when it isn't.
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  options: { intervalMs: number; attempts: number },
): Promise<T | null> {
  for (let i = 0; i < options.attempts; i++) {
    const result = await fn()
    if (result !== null) return result
    if (i < options.attempts - 1) await sleep(options.intervalMs)
  }
  return null
}
