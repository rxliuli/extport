import type { ChromeCredentials, CredentialCheck, StoreAdapter } from './types'
import { notImplemented, truncate, type FetchLike } from './util'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * Chrome Web Store — form-fallback mode: the tenant supplies their own OAuth
 * client (clientId/clientSecret) plus a refresh token with the
 * chromewebstore scope. Verification = a refresh-token exchange.
 */
export function createChromeAdapter(fetchImpl: FetchLike = (i, o) => fetch(i, o)): StoreAdapter<ChromeCredentials> {
  return {
    store: 'chrome',
    async verifyCredentials(credentials): Promise<CredentialCheck> {
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      })
      if (res.ok) return { ok: true }
      if (res.status >= 500) throw new Error(`google oauth unavailable (${res.status})`)
      return { ok: false, reason: `refresh token exchange failed: ${truncate(await res.text())}` }
    },
    getState: notImplemented('chrome', 'getState'),
    submit: notImplemented('chrome', 'submit'),
  }
}
