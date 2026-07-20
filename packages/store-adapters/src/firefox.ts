import type { CredentialCheck, FirefoxCredentials, StoreAdapter } from './types'
import { signJwtHS256 } from './jwt'
import { notImplemented, truncate, type FetchLike } from './util'

const PROFILE_URL = 'https://addons.mozilla.org/api/v5/accounts/profile/'

/** AMO issues (issuer, secret) pairs; every request carries a freshly signed short-lived JWT. */
export async function amoAuthHeader(credentials: FirefoxCredentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jwt = await signJwtHS256(
    {
      iss: credentials.jwtIssuer,
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 300,
    },
    credentials.jwtSecret,
  )
  return `JWT ${jwt}`
}

export function createFirefoxAdapter(fetchImpl: FetchLike = (i, o) => fetch(i, o)): StoreAdapter<FirefoxCredentials> {
  return {
    store: 'firefox',
    async verifyCredentials(credentials): Promise<CredentialCheck> {
      const res = await fetchImpl(PROFILE_URL, {
        headers: { authorization: await amoAuthHeader(credentials) },
      })
      if (res.ok) return { ok: true }
      if (res.status >= 500) throw new Error(`amo unavailable (${res.status})`)
      return { ok: false, reason: `amo rejected the JWT credentials: ${truncate(await res.text())}` }
    },
    getState: notImplemented('firefox', 'getState'),
    submit: notImplemented('firefox', 'submit'),
  }
}
