import type { Store } from '@extport/shared'

/**
 * Where a tenant can actually diagnose a failure — every caller of this is
 * a rejected/error notification (see reconcile/run.ts's NotifyKind), never
 * a "here's your listing" message, so the public consumer-facing page is
 * the wrong link on every store: it never shows submission status, a
 * rejection reason, or a draft's state, only whatever's already live. The
 * developer console does. (Confirmed the hard way for Edge specifically —
 * a rejection notification pointed at the public listing, which showed
 * nothing about the actual "In draft" state the dashboard would have.)
 *
 * Chrome needs the tenant's own publisherId to deep-link into their
 * console (`credentials` isn't always available where this is called from
 * — e.g. the credential itself failed to decrypt — so it falls back to the
 * public listing rather than omit a link entirely).
 */
export function storeConsoleUrl(store: Store, storeItemId: string, opts: { platform?: string; publisherId?: string } = {}): string {
  switch (store) {
    case 'chrome':
      return opts.publisherId
        ? `https://chrome.google.com/webstore/devconsole/${opts.publisherId}/${storeItemId}/edit`
        : `https://chromewebstore.google.com/detail/${storeItemId}`
    case 'firefox':
      return `https://addons.mozilla.org/en-US/developers/addon/${storeItemId}/versions`
    case 'edge':
      return `https://partner.microsoft.com/en-us/dashboard/microsoftedge/${storeItemId}/packages/dashboard`
    case 'safari':
      return `https://appstoreconnect.apple.com/apps/${storeItemId}/distribution/${opts.platform ?? 'macos'}/version/inflight`
  }
}
