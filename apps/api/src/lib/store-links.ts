import type { Store } from '@extport/shared'

/**
 * Where a tenant can see this listing for themselves — the same purpose as
 * the notification it's attached to: letting them check extport's claim
 * against what the store itself shows, not just take our word for it.
 *
 * Chrome/Firefox/Edge(with crxId) point at the store's own public listing —
 * no login required. Edge without a crxId and Safari fall back to their
 * developer console instead, since neither store exposes a public page
 * addressable by the id extport has on hand (Edge's Product ID is an
 * internal GUID; Safari never has a public listing url at all pre-release).
 */
export function storeConsoleUrl(store: Store, storeItemId: string, opts: { crxId?: string; platform?: string } = {}): string {
  switch (store) {
    case 'chrome':
      return `https://chromewebstore.google.com/detail/${storeItemId}`
    case 'firefox':
      return `https://addons.mozilla.org/firefox/addon/${storeItemId}/`
    case 'edge':
      return opts.crxId
        ? `https://microsoftedge.microsoft.com/addons/detail/${opts.crxId}`
        : `https://partner.microsoft.com/en-us/dashboard/microsoftedge/${storeItemId}/packages/dashboard`
    case 'safari':
      return `https://appstoreconnect.apple.com/apps/${storeItemId}/distribution/${opts.platform ?? 'macos'}/version/inflight`
  }
}
