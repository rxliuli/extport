import type { Store } from '@/api'

/**
 * `field` is which target-form field the extracted id belongs in. Edge is the
 * exception: its public listing URL carries the CRX ID, while the Product ID
 * the Submission API needs exists only in Partner Center — so an Edge URL can
 * never fill `storeItemId`.
 */
export interface ParsedListingUrl {
  store: Store
  field: 'storeItemId' | 'crxId'
  id: string
}

// Chrome extension ids (and Edge CRX ids) are 32 chars of the a-p alphabet.
const CRX_ID = /^[a-p]{32}$/

const KNOWN_HOSTS = [
  'chromewebstore.google.com',
  'chrome.google.com',
  'addons.mozilla.org',
  'microsoftedge.microsoft.com',
  'apps.apple.com',
  'itunes.apple.com',
]

/**
 * Extract the store item id (or Edge CRX id) from a pasted store listing URL.
 * Returns null for anything that isn't a recognizable listing URL — including
 * bare ids, which are ambiguous between stores and must pass through as typed.
 */
export function parseListingUrl(input: string): ParsedListingUrl | null {
  const url = toUrl(input.trim())
  if (!url) return null
  const segments = url.pathname.split('/').filter(Boolean)
  switch (url.hostname) {
    case 'chromewebstore.google.com':
    case 'chrome.google.com': {
      const id = segments.find((s) => CRX_ID.test(s))
      return id ? { store: 'chrome', field: 'storeItemId', id } : null
    }
    case 'addons.mozilla.org': {
      const i = segments.indexOf('addon')
      const slug = i >= 0 ? segments[i + 1] : undefined
      return slug ? { store: 'firefox', field: 'storeItemId', id: slug } : null
    }
    case 'microsoftedge.microsoft.com': {
      const id = segments.find((s) => CRX_ID.test(s))
      return id ? { store: 'edge', field: 'crxId', id } : null
    }
    case 'apps.apple.com':
    case 'itunes.apple.com': {
      for (const s of segments) {
        const m = /^id(\d+)$/.exec(s)
        if (m?.[1]) return { store: 'safari', field: 'storeItemId', id: m[1] }
      }
      return null
    }
    default:
      return null
  }
}

function toUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    // Scheme-less paste ("addons.mozilla.org/…") — only retry for known hosts
    // so ordinary non-URL input never round-trips through URL parsing.
    if (KNOWN_HOSTS.some((h) => value.toLowerCase().startsWith(`${h}/`))) {
      try {
        return new URL(`https://${value}`)
      } catch {
        return null
      }
    }
    return null
  }
}
