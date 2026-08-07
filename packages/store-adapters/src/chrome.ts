import type { ChromeCredentials, CredentialCheck, StoreAdapter, StoreState, SubmissionResult, VersionKnowledge } from './types'
import { signJwtRS256 } from './jwt'
import { truncate, type FetchLike } from './util'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API_BASE = 'https://chromewebstore.googleapis.com/v2'
const UPLOAD_BASE = 'https://chromewebstore.googleapis.com/upload/v2'
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore'
// Sent on every v2 call — present in Google's own sample code for both v1.1 and v2 clients.
const API_VERSION_HEADER = { 'x-goog-api-version': '2' }

function itemName(credentials: ChromeCredentials, storeItemId: string): string {
  return `publishers/${credentials.publisherId}/items/${storeItemId}`
}

type TokenResult = { ok: true; token: string } | { ok: false; status: number; body: string }

/**
 * V2 auth is a GCP service account: self-sign a short-lived JWT-bearer
 * assertion and exchange it for an access token — no OAuth consent screen,
 * no refresh token to expire (unlike the v1.1 flow this replaces).
 */
async function requestAccessToken(credentials: ChromeCredentials, fetchImpl: FetchLike): Promise<TokenResult> {
  const now = Math.floor(Date.now() / 1000)
  const assertion = await signJwtRS256(
    { iss: credentials.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 30 },
    { privateKeyPkcs8Pem: credentials.privateKey },
  )
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, status: res.status, body: text }
  const parsed = JSON.parse(text) as { access_token?: string }
  if (!parsed.access_token) return { ok: false, status: res.status, body: text }
  return { ok: true, token: parsed.access_token }
}

async function getAccessToken(credentials: ChromeCredentials, fetchImpl: FetchLike): Promise<string> {
  const result = await requestAccessToken(credentials, fetchImpl)
  if (!result.ok) throw new Error(`google oauth token exchange failed (${result.status}): ${truncate(result.body)}`)
  return result.token
}

async function verifyCredentials(credentials: ChromeCredentials, fetchImpl: FetchLike): Promise<CredentialCheck> {
  let result: TokenResult
  try {
    result = await requestAccessToken(credentials, fetchImpl)
  } catch {
    return { ok: false, reason: 'invalid service account private key (could not sign JWT)' }
  }
  if (result.ok) return { ok: true }
  if (result.status >= 500) throw new Error(`google oauth unavailable (${result.status})`)
  return { ok: false, reason: `service account rejected: ${truncate(result.body)}` }
}

async function getState(
  credentials: ChromeCredentials,
  storeItemId: string,
  fetchImpl: FetchLike,
): Promise<StoreState> {
  const token = await getAccessToken(credentials, fetchImpl)
  const res = await fetchImpl(`${API_BASE}/${itemName(credentials, storeItemId)}:fetchStatus`, {
    headers: { authorization: `Bearer ${token}`, ...API_VERSION_HEADER },
  })
  if (!res.ok) throw new Error(`chrome fetchStatus failed (${res.status}): ${truncate(await res.text())}`)
  const body = (await res.json()) as {
    publishedItemRevisionStatus?: { state?: string; distributionChannels?: { crxVersion?: string }[] }
    submittedItemRevisionStatus?: { state?: string; distributionChannels?: { crxVersion?: string }[] }
  }
  const published = body.publishedItemRevisionStatus
  const submitted = body.submittedItemRevisionStatus
  const publishedVersion = published?.distributionChannels?.[0]?.crxVersion
  // Google's schema gives distributionChannels[] no channel-identity field at
  // all (confirmed against the v2 reference), so index 0 isn't documented to
  // always be populated once state flips to PUBLISHED — but every real
  // response seen so far has had it. Logged instead of "fixed" so a real
  // occurrence can justify a real fix (with a real payload to design it
  // against), rather than coding a fallback for a gap that's never actually
  // been confirmed to happen.
  if (published?.state === 'PUBLISHED' && !publishedVersion) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'chrome fetchStatus: state is PUBLISHED but distributionChannels has no crxVersion',
        storeItemId,
        publishedItemRevisionStatus: published,
      }),
    )
  }
  const live: VersionKnowledge = { known: true, version: publishedVersion }
  if (!submitted) return { live, inReview: { known: true } }

  const submittedVersion = submitted.distributionChannels?.[0]?.crxVersion
  if (submitted.state === 'PENDING_REVIEW' || submitted.state === 'STAGED') {
    return { live, inReview: { known: true, version: submittedVersion }, reviewStatus: 'pending' }
  }
  if (submitted.state === 'REJECTED' || submitted.state === 'CANCELLED') {
    return {
      live,
      inReview: { known: true },
      reviewStatus: 'rejected',
      // Google does not expose rejection text via the API (confirmed 2026-07 research) — only the Dashboard/email do.
      rejectionReason: 'Chrome Web Store does not expose rejection reasons via API — check the Developer Dashboard or your email.',
    }
  }
  return { live, inReview: { known: true } }
}

async function submit(
  credentials: ChromeCredentials,
  storeItemId: string,
  artifact: ArrayBuffer,
  fetchImpl: FetchLike,
): Promise<SubmissionResult> {
  const token = await getAccessToken(credentials, fetchImpl)
  const name = itemName(credentials, storeItemId)

  const uploadRes = await fetchImpl(`${UPLOAD_BASE}/${name}:upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...API_VERSION_HEADER, 'content-type': 'application/zip' },
    body: artifact,
  })
  if (!uploadRes.ok) {
    return { submitted: false, detail: `upload failed (${uploadRes.status}): ${truncate(await uploadRes.text())}` }
  }
  // V2 upload is synchronous — no polling needed, just check uploadState.
  const uploadBody = (await uploadRes.json()) as { uploadState?: string; itemError?: unknown }
  if (uploadBody.uploadState !== 'SUCCEEDED') {
    return {
      submitted: false,
      detail: `upload state ${uploadBody.uploadState ?? 'unknown'}: ${truncate(JSON.stringify(uploadBody.itemError ?? ''))}`,
    }
  }

  const publishRes = await fetchImpl(`${API_BASE}/${name}:publish`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...API_VERSION_HEADER, 'content-type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
  })
  if (!publishRes.ok) {
    return { submitted: false, detail: `publish failed (${publishRes.status}): ${truncate(await publishRes.text())}` }
  }
  return { submitted: true }
}

async function withdraw(credentials: ChromeCredentials, storeItemId: string, fetchImpl: FetchLike): Promise<void> {
  const token = await getAccessToken(credentials, fetchImpl)
  const res = await fetchImpl(`${API_BASE}/${itemName(credentials, storeItemId)}:cancelSubmission`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...API_VERSION_HEADER, 'content-type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`chrome cancelSubmission failed (${res.status}): ${truncate(await res.text())}`)
}

/**
 * Chrome Web Store Publish API v2 (v1.1 sunsets 2026-10-15). Auth is a
 * per-tenant GCP service account — see ChromeCredentials for the exact
 * fields and the setup a tenant needs to do once in the Cloud Console +
 * Web Store Developer Dashboard.
 */
export function createChromeAdapter(fetchImpl: FetchLike = (i, o) => fetch(i, o)): StoreAdapter<ChromeCredentials> {
  return {
    store: 'chrome',
    verifyCredentials: (credentials) => verifyCredentials(credentials, fetchImpl),
    getState: (credentials, target) => getState(credentials, target.storeItemId, fetchImpl),
    submit: (credentials, target, artifact) => submit(credentials, target.storeItemId, artifact, fetchImpl),
    withdraw: (credentials, target) => withdraw(credentials, target.storeItemId, fetchImpl),
  }
}
