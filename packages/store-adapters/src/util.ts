/** Injectable fetch so adapters are unit-testable without network access. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
