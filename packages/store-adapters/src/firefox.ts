import type { CredentialCheck, FirefoxCredentials, StoreAdapter, StoreState, SubmissionResult, VersionKnowledge } from './types'
import { signJwtHS256 } from './jwt'
import { pollUntil, truncate, type FetchLike } from './util'

const BASE = 'https://addons.mozilla.org'
const PROFILE_URL = `${BASE}/api/v5/accounts/profile/`
const UPLOAD_URL = `${BASE}/api/v5/addons/upload/`

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
  // AMO expects "JWT <token>", not "Bearer <token>".
  return `JWT ${jwt}`
}

function addonUrl(addonId: string, suffix = ''): string {
  return `${BASE}/api/v5/addons/addon/${encodeURIComponent(addonId)}${suffix}`
}

async function getState(
  credentials: FirefoxCredentials,
  addonId: string,
  fetchImpl: FetchLike,
): Promise<StoreState> {
  const res = await fetchImpl(addonUrl(addonId, '/'), {
    headers: { authorization: await amoAuthHeader(credentials) },
  })
  if (!res.ok) throw new Error(`amo addon lookup failed (${res.status}): ${truncate(await res.text())}`)
  const addon = (await res.json()) as { current_version?: { version?: string } | null }
  const liveVersion = addon.current_version?.version
  const live: VersionKnowledge = { known: true, version: liveVersion }

  const versionsRes = await fetchImpl(addonUrl(addonId, '/versions/?page_size=5'), {
    headers: { authorization: await amoAuthHeader(credentials) },
  })
  if (!versionsRes.ok) return { live, inReview: { known: true } }
  const versions = (await versionsRes.json()) as {
    results?: { version?: string; file?: { status?: string } }[]
  }
  const latest = versions.results?.[0]
  if (!latest?.version || latest.version === liveVersion) return { live, inReview: { known: true } }

  if (latest.file?.status === 'unreviewed') {
    return { live, inReview: { known: true, version: latest.version }, reviewStatus: 'pending' }
  }
  if (latest.file?.status === 'disabled') {
    // AMO conflates "rejected by review" and "manually disabled" into one status —
    // this is the best signal the public API exposes (confirmed 2026-07 research).
    return {
      live,
      inReview: { known: true },
      reviewStatus: 'rejected',
      rejectionReason: 'AMO marked this version disabled/rejected — check Review Notes in the Developer Hub for details.',
    }
  }
  return { live, inReview: { known: true } }
}

export interface PollOptions {
  intervalMs: number
  attempts: number
}

const DEFAULT_POLL: PollOptions = { intervalMs: 4000, attempts: 5 }

async function submit(
  credentials: FirefoxCredentials,
  addonId: string,
  artifact: ArrayBuffer,
  fetchImpl: FetchLike,
  poll: PollOptions,
  sourceArtifact?: ArrayBuffer,
): Promise<SubmissionResult> {
  const form = new FormData()
  form.append('channel', 'listed')
  form.append('upload', new Blob([artifact], { type: 'application/zip' }), 'extension.zip')
  const uploadRes = await fetchImpl(UPLOAD_URL, {
    method: 'POST',
    headers: { authorization: await amoAuthHeader(credentials) },
    body: form,
  })
  if (!uploadRes.ok) {
    return { submitted: false, detail: `upload rejected (${uploadRes.status}): ${truncate(await uploadRes.text())}` }
  }
  const uploadBody = (await uploadRes.json()) as { uuid: string }
  const uuid = uploadBody.uuid

  // AMO validates asynchronously (usually seconds). Poll briefly and finish
  // the create-version step now if it completes in time; if not, don't fail —
  // just retry the whole upload on the next reconcile tick (cheap, and AMO's
  // daily upload quota comfortably covers a 30-minute reconcile cadence).
  const processed = await pollUntil(
    async () => {
      const res = await fetchImpl(`${UPLOAD_URL}${uuid}/`, {
        headers: { authorization: await amoAuthHeader(credentials) },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { processed?: boolean; valid?: boolean; validation?: unknown }
      return body.processed ? body : null
    },
    poll,
  )

  if (!processed) {
    return { submitted: true, detail: 'upload accepted, still validating — will confirm on the next reconcile' }
  }
  if (!processed.valid) {
    return { submitted: false, detail: `validation failed: ${truncate(JSON.stringify(processed.validation ?? ''))}` }
  }

  // AMO requires source for bundled/minified submissions, uploaded alongside
  // the main zip in this same call — not a separate endpoint (confirmed
  // against aklinker1/publish-browser-extension, the reference implementation
  // wxt's own `wxt submit` uses). An empty `source` field is fine when the
  // tenant didn't provide one; AMO only requires it when its own automated
  // check flags the submission as needing one.
  const versionBody = new FormData()
  versionBody.set('upload', uuid)
  versionBody.set('source', sourceArtifact ? new Blob([sourceArtifact], { type: 'application/zip' }) : '')
  const versionRes = await fetchImpl(addonUrl(addonId, '/versions/'), {
    method: 'POST',
    headers: { authorization: await amoAuthHeader(credentials) },
    body: versionBody,
  })
  if (!versionRes.ok) {
    return { submitted: false, detail: `version creation failed (${versionRes.status}): ${truncate(await versionRes.text())}` }
  }
  return { submitted: true }
}

export function createFirefoxAdapter(
  fetchImpl: FetchLike = (i, o) => fetch(i, o),
  poll: PollOptions = DEFAULT_POLL,
): StoreAdapter<FirefoxCredentials> {
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
    getState: (credentials, target) => getState(credentials, target.storeItemId, fetchImpl),
    submit: (credentials, target, artifact, _version, _platform, sourceArtifact) =>
      submit(credentials, target.storeItemId, artifact, fetchImpl, poll, sourceArtifact),
    // Firefox review is automated/near-instant for the vast majority of submissions —
    // there is nothing in-flight to cancel by the time we could act on it.
  }
}
