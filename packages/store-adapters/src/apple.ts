import type { AppleCredentials, CredentialCheck, StoreAdapter } from './types'
import { signJwtES256 } from './jwt'
import { notImplemented, truncate, type FetchLike } from './util'

const API_BASE = 'https://api.appstoreconnect.apple.com'

/** App Store Connect: ES256 JWT from a .p8 key (App Manager role recommended). */
export async function ascAuthHeader(credentials: AppleCredentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jwt = await signJwtES256(
    {
      iss: credentials.issuerId,
      iat: now,
      exp: now + 600,
      aud: 'appstoreconnect-v1',
    },
    { keyId: credentials.keyId, privateKeyP8: credentials.privateKeyP8 },
  )
  return `Bearer ${jwt}`
}

export function createAppleAdapter(fetchImpl: FetchLike = (i, o) => fetch(i, o)): StoreAdapter<AppleCredentials> {
  return {
    store: 'apple',
    async verifyCredentials(credentials): Promise<CredentialCheck> {
      let authorization: string
      try {
        authorization = await ascAuthHeader(credentials)
      } catch {
        return { ok: false, reason: 'invalid .p8 private key (could not sign JWT)' }
      }
      const res = await fetchImpl(`${API_BASE}/v1/apps?limit=1`, { headers: { authorization } })
      if (res.ok) return { ok: true }
      if (res.status >= 500) throw new Error(`app store connect unavailable (${res.status})`)
      return { ok: false, reason: `app store connect rejected the key: ${truncate(await res.text())}` }
    },
    getState: notImplemented('apple', 'getState'),
    submit: notImplemented('apple', 'submit'),
  }
}
