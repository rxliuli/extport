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

/**
 * Per-attempt bound on one store API call (headers and body). Every
 * reconcile-path call is a single REST request; none legitimately takes
 * minutes. Without a bound, a store that accepts the connection and never
 * answers (ASC during its 2026-11-17 incident) held a target's reconcile
 * lock until the invocation itself died, and every sync in between was
 * silently skipped. Generous on purpose: no per-call timing existed to tune
 * against — the slow-call log below is what supplies it.
 */
export const REQUEST_TIMEOUT_MS = 60_000
// Calls slower than this are logged with their duration.
const SLOW_REQUEST_MS = 10_000

/**
 * Bounds every call through `fetchImpl` by `timeoutMs` and logs slow ones.
 * Sits under fetchWithRetry, so the bound is per attempt; a timeout throws,
 * which fetchWithRetry deliberately doesn't retry.
 */
export function fetchWithTimeout(fetchImpl: FetchLike, store: string, timeoutMs = REQUEST_TIMEOUT_MS): FetchLike {
  return async (input, init) => {
    const started = Date.now()
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const method = init?.method ?? 'GET'
    const path = requestPath(input)
    try {
      const res = await fetchImpl(input, { ...init, signal })
      const ms = Date.now() - started
      if (ms >= SLOW_REQUEST_MS) {
        console.warn(JSON.stringify({ level: 'warn', message: 'slow store request', store, method, path, status: res.status, ms }))
      }
      return res
    } catch (err) {
      if (!timeout.aborted) throw err
      console.warn(JSON.stringify({ level: 'warn', message: 'store request timed out', store, method, path, ms: Date.now() - started }))
      throw new Error(`${store} request timed out after ${Math.round(timeoutMs / 1000)}s: ${method} ${path}`)
    }
  }
}

function requestPath(input: string): string {
  try {
    return new URL(input).pathname
  } catch {
    return input
  }
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
