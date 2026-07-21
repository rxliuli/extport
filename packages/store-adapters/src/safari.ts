import type { SafariCredentials, CredentialCheck, StoreAdapter, StoreState, StoreTarget, SubmissionResult } from './types'
import { signJwtES256 } from './jwt'
import { truncate, type FetchLike } from './util'

const API_BASE = 'https://api.appstoreconnect.apple.com'

// PREPARE_FOR_SUBMISSION is deliberately excluded — it's just an editable
// draft (exactly what our own submit() creates before a reviewSubmission
// succeeds), not a genuine Apple review in progress. Bucketing it as
// "in review" would make the very draft a failed submit() leaves behind
// look like a success on the next tick — decide() would then stop
// retrying forever while the version sits untouched at Apple.
const IN_REVIEW_STATES = new Set(['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'WAITING_FOR_EXPORT_COMPLIANCE'])
const REJECTED_STATES = new Set(['REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY', 'DEVELOPER_REJECTED'])
const LIVE_STATES = new Set([
  'READY_FOR_DISTRIBUTION',
  'PENDING_DEVELOPER_RELEASE',
  'PENDING_APPLE_RELEASE',
  'PROCESSING_FOR_DISTRIBUTION',
])

/**
 * One App Store Connect app spans macOS and iOS with fully independent
 * version/review timelines — these are the reconciler-facing platform names
 * (deployment_versions.platform) mapped to ASC's enum.
 */
export const SAFARI_PLATFORMS = ['macos', 'ios'] as const
const ASC_PLATFORM: Record<string, string> = { macos: 'MAC_OS', ios: 'IOS' }

/** Filled into empty "What's New" fields — required for review, not inherited. */
const DEFAULT_WHATS_NEW = 'Bug fixes and improvements.'

function ascPlatform(platform: string | undefined): string {
  const mapped = platform ? ASC_PLATFORM[platform] : undefined
  if (!mapped) throw new Error(`safari adapter requires a platform (macos | ios), got ${JSON.stringify(platform)}`)
  return mapped
}

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

async function getState(credentials: SafariCredentials, appId: string, platform: string, fetchImpl: FetchLike): Promise<StoreState> {
  const authorization = await ascAuthHeader(credentials)
  // No `sort` param exists on this endpoint (confirmed against the API docs —
  // requesting one is a 400) — filter server-side by platform and by the
  // states we actually care about instead of paging through everything and
  // hoping the version we want is in a small, arbitrarily-ordered page.
  const res = await fetchImpl(
    `${API_BASE}/v1/apps/${appId}/appStoreVersions?limit=10&filter[platform]=${ascPlatform(platform)}&filter[appVersionState]=${RELEVANT_STATES.join(',')}&fields[appStoreVersions]=versionString,appVersionState`,
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

interface AscResource {
  id: string
  attributes?: Record<string, unknown>
}

/**
 * Orchestrates a review submission for a binary the tenant's macOS pipeline
 * already uploaded to App Store Connect (docs/safari-pipeline.md — the ASC
 * REST API cannot upload binaries, so extport never sees them; the artifact
 * bytes passed by the reconciler are the web-extension zip and are ignored).
 *
 * Steps: find a processed build for (version, platform) — `waiting` until
 * one exists — then create/reuse the appStoreVersion, attach the build, and
 * submit through the reviewSubmissions flow. Idempotent against partial
 * progress from an earlier failed tick (reuses an existing version row and
 * an open draft submission, skips an already-added item).
 */
async function submit(
  credentials: SafariCredentials,
  appId: string,
  version: string,
  platform: string,
  fetchImpl: FetchLike,
): Promise<SubmissionResult> {
  const authorization = await ascAuthHeader(credentials)
  const headers = { authorization, 'content-type': 'application/json' }
  const platformValue = ascPlatform(platform)

  const fail = async (step: string, res: Response): Promise<SubmissionResult> => ({
    submitted: false,
    detail: `${step} failed (${res.status}): ${truncate(await res.text())}`,
  })

  // 1. A processed build must already exist — uploaded out-of-band by the
  //    tenant's macOS pipeline. Until it appears this is a normal wait, not
  //    an error.
  const buildsRes = await fetchImpl(
    `${API_BASE}/v1/builds?filter[app]=${appId}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&filter[preReleaseVersion.platform]=${platformValue}&filter[processingState]=VALID&filter[expired]=false&limit=1`,
    { headers: { authorization } },
  )
  if (!buildsRes.ok) return fail('build lookup', buildsRes)
  const build = ((await buildsRes.json()) as { data?: AscResource[] }).data?.[0]
  if (!build) {
    return {
      submitted: false,
      waiting: true,
      detail: `waiting for a processed ${platform} build of v${version} to appear in App Store Connect`,
    }
  }

  // 2. Create or reuse the appStoreVersion for this (platform, version).
  const versionsRes = await fetchImpl(
    `${API_BASE}/v1/apps/${appId}/appStoreVersions?filter[platform]=${platformValue}&filter[versionString]=${encodeURIComponent(version)}&limit=1`,
    { headers: { authorization } },
  )
  if (!versionsRes.ok) return fail('version lookup', versionsRes)
  let appStoreVersion = ((await versionsRes.json()) as { data?: AscResource[] }).data?.[0]
  if (!appStoreVersion) {
    const createRes = await fetchImpl(`${API_BASE}/v1/appStoreVersions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        data: {
          type: 'appStoreVersions',
          attributes: { platform: platformValue, versionString: version },
          relationships: { app: { data: { type: 'apps', id: appId } } },
        },
      }),
    })
    if (!createRes.ok) return fail('version create', createRes)
    appStoreVersion = ((await createRes.json()) as { data: AscResource }).data
  }

  // 3. Attach the build to the version.
  const attachRes = await fetchImpl(`${API_BASE}/v1/appStoreVersions/${appStoreVersion.id}/relationships/build`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ data: { type: 'builds', id: build.id } }),
  })
  if (!attachRes.ok) return fail('build attach', attachRes)

  // 3.5 The App Store requires per-version release notes ("What's New")
  //     before a version may enter review, and they are NOT inherited from
  //     the previous version — a freshly created version always lacks them,
  //     which Apple surfaces as a cryptic 409 on the submission item ("is
  //     not in valid state"). Fill exactly the localizations that are empty;
  //     notes someone hand-wrote in App Store Connect always win. Default
  //     text matches safari-webext-publish-action's release-notes default.
  const locsRes = await fetchImpl(
    `${API_BASE}/v1/appStoreVersions/${appStoreVersion.id}/appStoreVersionLocalizations?limit=50`,
    { headers: { authorization } },
  )
  if (!locsRes.ok) return fail('localizations lookup', locsRes)
  const localizations = ((await locsRes.json()) as { data?: AscResource[] }).data ?? []
  for (const localization of localizations) {
    const whatsNew = localization.attributes?.whatsNew
    if (typeof whatsNew === 'string' && whatsNew.trim()) continue
    const notesRes = await fetchImpl(`${API_BASE}/v1/appStoreVersionLocalizations/${localization.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        data: { type: 'appStoreVersionLocalizations', id: localization.id, attributes: { whatsNew: DEFAULT_WHATS_NEW } },
      }),
    })
    if (!notesRes.ok) return fail('release notes update', notesRes)
  }

  // 4. Reuse an open draft review submission for this platform, or create one.
  const openRes = await fetchImpl(
    `${API_BASE}/v1/apps/${appId}/reviewSubmissions?filter[platform]=${platformValue}&filter[state]=READY_FOR_REVIEW&limit=1`,
    { headers: { authorization } },
  )
  if (!openRes.ok) return fail('review submission lookup', openRes)
  let submission = ((await openRes.json()) as { data?: AscResource[] }).data?.[0]
  if (!submission) {
    const createSubRes = await fetchImpl(`${API_BASE}/v1/reviewSubmissions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: platformValue },
          relationships: { app: { data: { type: 'apps', id: appId } } },
        },
      }),
    })
    if (!createSubRes.ok) return fail('review submission create', createSubRes)
    submission = ((await createSubRes.json()) as { data: AscResource }).data
  }

  // 5. Add the version as a submission item (skip if a retry already did).
  const itemsRes = await fetchImpl(`${API_BASE}/v1/reviewSubmissions/${submission.id}/items?limit=50`, {
    headers: { authorization },
  })
  if (!itemsRes.ok) return fail('submission items lookup', itemsRes)
  const items = ((await itemsRes.json()) as { data?: { relationships?: { appStoreVersion?: { data?: { id?: string } } } }[] }).data ?? []
  const alreadyAdded = items.some((item) => item.relationships?.appStoreVersion?.data?.id === appStoreVersion.id)
  if (!alreadyAdded) {
    const addItemRes = await fetchImpl(`${API_BASE}/v1/reviewSubmissionItems`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
            appStoreVersion: { data: { type: 'appStoreVersions', id: appStoreVersion.id } },
          },
        },
      }),
    })
    if (!addItemRes.ok) return fail('submission item add', addItemRes)
  }

  // 6. Submit for review.
  const submitRes = await fetchImpl(`${API_BASE}/v1/reviewSubmissions/${submission.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } }),
  })
  if (!submitRes.ok) return fail('review submit', submitRes)

  return { submitted: true, detail: `submitted ${platform} v${version} (build ${build.id}) for App Store review` }
}

async function withdraw(credentials: SafariCredentials, appId: string, platform: string | undefined, fetchImpl: FetchLike): Promise<void> {
  const authorization = await ascAuthHeader(credentials)
  const platformFilter = platform ? `&filter[platform]=${ascPlatform(platform)}` : ''
  const lookupRes = await fetchImpl(
    `${API_BASE}/v1/apps/${appId}/reviewSubmissions?filter[state]=WAITING_FOR_REVIEW,IN_REVIEW${platformFilter}&limit=1`,
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
 * App Store Connect API. The binary itself never travels through extport —
 * the ASC API cannot upload one; the tenant's macOS pipeline builds and
 * uploads it out-of-band, and submit() here only orchestrates the review
 * (find build → version → attach → submit), waiting until the build shows
 * up. See docs/safari-pipeline.md (spec §8).
 */
export function createSafariAdapter(fetchImpl: FetchLike = (i, o) => fetch(i, o)): StoreAdapter<SafariCredentials> {
  return {
    store: 'safari',
    platforms: SAFARI_PLATFORMS,
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
    getState: (credentials, target: StoreTarget, platform?: string) => getState(credentials, target.storeItemId, platform ?? 'macos', fetchImpl),
    submit: (credentials, target, _artifact, version, platform) =>
      submit(credentials, target.storeItemId, version, platform ?? 'macos', fetchImpl),
    withdraw: (credentials, target, platform) => withdraw(credentials, target.storeItemId, platform, fetchImpl),
  }
}
