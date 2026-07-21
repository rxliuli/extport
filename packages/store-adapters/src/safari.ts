import type { SafariCredentials, CredentialCheck, StoreAdapter, StoreState } from './types'
import { signJwtES256 } from './jwt'
import { truncate, type FetchLike } from './util'

const API_BASE = 'https://api.appstoreconnect.apple.com'

const IN_REVIEW_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'WAITING_FOR_EXPORT_COMPLIANCE',
])
const REJECTED_STATES = new Set(['REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY', 'DEVELOPER_REJECTED'])
const LIVE_STATES = new Set([
  'READY_FOR_DISTRIBUTION',
  'PENDING_DEVELOPER_RELEASE',
  'PENDING_APPLE_RELEASE',
  'PROCESSING_FOR_DISTRIBUTION',
])

/** App Store Connect: ES256 JWT from a .p8 key (App Manager role recommended). */
export async function ascAuthHeader(credentials: SafariCredentials): Promise<string> {
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

const RELEVANT_STATES = [...LIVE_STATES, ...IN_REVIEW_STATES, ...REJECTED_STATES]

async function getState(credentials: SafariCredentials, appId: string, fetchImpl: FetchLike): Promise<StoreState> {
  const authorization = await ascAuthHeader(credentials)
  // No `sort` param exists on this endpoint (confirmed against the API docs —
  // requesting one is a 400) — filter server-side by the states we actually
  // care about instead of paging through everything and hoping the version
  // we want is recent enough to be in a small, arbitrarily-ordered page.
  //
  // MAC_OS only, deliberately: one ASC app covers both macOS and iOS with
  // independent per-platform version timelines, and without this filter the
  // response mixes them in arbitrary order — first-match would flip between
  // platforms whenever their versions diverge. Tracking macOS alone is an
  // explicit interim stance, not a limitation of the API; per-platform
  // lifecycles (one safari target, two tracked timelines) are deferred to
  // the Safari submit pipeline work (spec §8), which is what actually needs
  // them.
  const res = await fetchImpl(
    `${API_BASE}/v1/apps/${appId}/appStoreVersions?limit=10&filter[platform]=MAC_OS&filter[appVersionState]=${RELEVANT_STATES.join(',')}&fields[appStoreVersions]=versionString,appVersionState`,
    { headers: { authorization } },
  )
  if (!res.ok) throw new Error(`app store connect versions lookup failed (${res.status}): ${truncate(await res.text())}`)
  const body = (await res.json()) as {
    data?: { attributes?: { versionString?: string; appVersionState?: string } }[]
  }

  let liveVersion: string | undefined
  let inReviewVersion: string | undefined
  let reviewStatus: 'pending' | 'rejected' | undefined
  for (const version of body.data ?? []) {
    const state = version.attributes?.appVersionState
    const versionString = version.attributes?.versionString
    if (!state || !versionString) continue
    if (liveVersion === undefined && LIVE_STATES.has(state)) liveVersion = versionString
    if (inReviewVersion === undefined && IN_REVIEW_STATES.has(state)) {
      inReviewVersion = versionString
      reviewStatus = 'pending'
    }
    if (!reviewStatus && REJECTED_STATES.has(state)) reviewStatus = 'rejected'
  }

  return {
    live: { known: true, version: liveVersion },
    inReview: { known: true, version: inReviewVersion },
    reviewStatus,
    rejectionReason: reviewStatus === 'rejected' ? 'Check App Store Connect → Activity for Apple’s rejection notes.' : undefined,
  }
}

async function withdraw(credentials: SafariCredentials, appId: string, fetchImpl: FetchLike): Promise<void> {
  const authorization = await ascAuthHeader(credentials)
  const lookupRes = await fetchImpl(
    `${API_BASE}/v1/apps/${appId}/reviewSubmissions?filter[state]=WAITING_FOR_REVIEW,IN_REVIEW&limit=1`,
    { headers: { authorization } },
  )
  if (!lookupRes.ok) {
    throw new Error(`app store connect review submission lookup failed (${lookupRes.status}): ${truncate(await lookupRes.text())}`)
  }
  const body = (await lookupRes.json()) as { data?: { id: string }[] }
  const submission = body.data?.[0]
  if (!submission) return // nothing in flight to cancel

  const cancelRes = await fetchImpl(`${API_BASE}/v1/reviewSubmissions/${submission.id}`, {
    method: 'PATCH',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({
      data: { type: 'reviewSubmissions', id: submission.id, attributes: { canceled: true } },
    }),
  })
  if (!cancelRes.ok) {
    throw new Error(`app store connect cancel failed (${cancelRes.status}): ${truncate(await cancelRes.text())}`)
  }
}

/**
 * App Store Connect API. `submit` is intentionally unimplemented: this API
 * cannot upload a binary — a build must come from an external macOS pipeline
 * (Xcode/Transporter) first. That pipeline is spec §8 (Safari conversion),
 * not yet built. `getState`/`withdraw` are pure REST and work today against
 * any app/build the tenant already manages manually.
 */
export function createSafariAdapter(fetchImpl: FetchLike = (i, o) => fetch(i, o)): StoreAdapter<SafariCredentials> {
  return {
    store: 'safari',
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
    getState: (credentials, target) => getState(credentials, target.storeItemId, fetchImpl),
    submit: () =>
      Promise.reject(
        new Error(
          'safari.submit is not implemented: the App Store Connect API cannot upload a binary — a build must be ' +
            'produced by an external macOS pipeline (Xcode/Transporter) first. See spec §8 (Safari conversion pipeline).',
        ),
      ),
    withdraw: (credentials, target) => withdraw(credentials, target.storeItemId, fetchImpl),
  }
}
