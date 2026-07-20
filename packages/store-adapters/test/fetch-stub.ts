import type { FetchLike } from '../src/util'

export interface Captured {
  url: string
  init?: RequestInit
}

export interface StubEntry {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

/** Serves each queued entry in order, one per fetch call; the last entry repeats once exhausted. */
export function queueFetch(entries: StubEntry[]): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = []
  let i = 0
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init })
    const entry = entries[Math.min(i, entries.length - 1)]
    i++
    if (!entry) throw new Error('queueFetch: no entries configured')
    const body = entry.body === undefined ? '' : typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body)
    return Promise.resolve(new Response(body, { status: entry.status, headers: entry.headers }))
  }
  return { fetch, calls }
}

/** A fetch that must never be called — throws immediately if it is. */
export const unreachableFetch: FetchLike = () => {
  throw new Error('fetch should not have been called')
}
