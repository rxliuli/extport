import type { Store } from '@extport/shared'

/** Injectable fetch so adapters are unit-testable without network access. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function notImplemented(store: Store, method: string): () => Promise<never> {
  // Milestone 3 fills these in, in order: chrome → firefox → edge → apple.
  return () => Promise.reject(new Error(`${store}.${method} not implemented yet`))
}
