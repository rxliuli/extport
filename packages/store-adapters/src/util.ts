/** Injectable fetch so adapters are unit-testable without network access. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

// Sized so one complete store error fits untruncated — ASC's structured
// error JSON runs ~450 chars and its "detail" sentence was the part a
// 300 cap kept eating (Redirector, 2026-08-21) — while an AMO outage
// page (full HTML document) stays bounded.
export function truncate(text: string, max = 1000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
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
