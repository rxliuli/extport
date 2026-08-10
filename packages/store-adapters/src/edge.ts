import type { CredentialCheck, EdgeCredentials, StoreAdapter, StoreState, StoreTarget, SubmissionResult } from './types'
import { pollUntil, truncate, type FetchLike } from './util'

const API_BASE = 'https://api.addons.microsoftedge.microsoft.com'
const PROBE_ID = '00000000-0000-0000-0000-000000000000'
// The consumer-facing store detail page's own data source, discovered by
// inspecting its network traffic — not part of any documented Partner
// Center API, unauthenticated, and could change shape or disappear without
// notice. Only ever used as a best-effort fallback (see getState below).
const STORE_DETAIL_URL = 'https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid'

export function edgeHeaders(credentials: EdgeCredentials): Record<string, string> {
  return {
    authorization: `ApiKey ${credentials.apiKey}`,
    'x-clientid': credentials.clientId,
  }
}

interface OperationStatus {
  status?: string
  message?: string
  errorCode?: string
}

export interface PollOptions {
  intervalMs: number
  attempts: number
}

const DEFAULT_POLL: PollOptions = { intervalMs: 3000, attempts: 10 }

function operationIdFromLocation(res: Response): string | null {
  const location = res.headers.get('location')
  if (!location) return null
  const id = location.split('/').filter(Boolean).pop()
  return id || null
}

async function pollOperation(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  poll: PollOptions,
): Promise<OperationStatus | null> {
  return pollUntil(async () => {
    const res = await fetchImpl(url, { headers })
    if (!res.ok) return null
    const body = (await res.json()) as OperationStatus
    return body.status === 'InProgress' ? null : body
  }, poll)
}

async function submit(
  credentials: EdgeCredentials,
  productId: string,
  artifact: ArrayBuffer,
  fetchImpl: FetchLike,
  poll: PollOptions,
): Promise<SubmissionResult> {
  const headers = edgeHeaders(credentials)
  const tag = `[edge ${productId.slice(0, 8)}]`

  console.log(`${tag} uploading package (${artifact.byteLength} bytes)`)
  const uploadRes = await fetchImpl(`${API_BASE}/v1/products/${productId}/submissions/draft/package`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/zip' },
    body: artifact,
  })
  if (uploadRes.status !== 202) {
    const body = await uploadRes.text()
    console.log(`${tag} upload rejected (${uploadRes.status}): ${body}`)
    return { submitted: false, detail: `package upload rejected (${uploadRes.status}): ${truncate(body)}` }
  }
  const uploadOperationId = operationIdFromLocation(uploadRes)
  if (!uploadOperationId) {
    console.log(`${tag} upload 202 but no operation id in Location header`)
    return { submitted: false, detail: 'edge did not return an operation id for the package upload' }
  }
  console.log(`${tag} upload accepted, validation operation ${uploadOperationId}`)

  const validated = await pollOperation(
    `${API_BASE}/v1/products/${productId}/submissions/draft/package/operations/${uploadOperationId}`,
    headers,
    fetchImpl,
    poll,
  )
  if (!validated) {
    console.log(`${tag} validation poll timed out after ${poll.attempts} attempts`)
    // Not a failure — validation just outlasted our poll window. `waiting`
    // keeps the version queued without recording a target error each tick.
    return { submitted: false, waiting: true, detail: 'package validation still in progress after the poll window — will retry next reconcile' }
  }
  if (validated.status !== 'Succeeded') {
    console.log(`${tag} validation failed: ${JSON.stringify(validated)}`)
    return { submitted: false, detail: `package validation failed: ${validated.errorCode ?? ''} ${truncate(validated.message ?? '')}`.trim() }
  }
  console.log(`${tag} validation succeeded, submitting for review`)

  const submitRes = await fetchImpl(`${API_BASE}/v1/products/${productId}/submissions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ notes: 'Submitted automatically by extport.' }),
  })
  if (submitRes.status !== 202) {
    const body = await submitRes.text()
    console.log(`${tag} submission rejected (${submitRes.status}): ${body}`)
    // "InProgressSubmission" is Edge's busy signal, not a failure: another
    // submission for this product is still mid-certification. That can be a
    // retry racing its own still-processing first attempt (Twitter Blocker,
    // 2026-08-05) or a submission whose confirming DB write was lost, so the
    // ledger doesn't even know it exists (Gemini Exporter, 2026-08-10:
    // v0.0.7 accepted store-side, the invocation died before recording it,
    // and — because getState() can never see Edge's in-review state — every
    // later tick tried to submit v0.0.8 into the occupied slot). It clears
    // by itself when that review resolves, and the queued row just needs to
    // try again after — the same shape as the validation timeout above, so
    // the same `waiting`, not a target error and an email.
    if (body.includes('InProgressSubmission')) {
      return { submitted: false, waiting: true, detail: 'Edge is still reviewing an earlier submission — will retry next reconcile' }
    }
    return { submitted: false, detail: `submission rejected (${submitRes.status}): ${truncate(body)}` }
  }
  const submitOperationId = operationIdFromLocation(submitRes)
  if (!submitOperationId) {
    console.log(`${tag} submission 202 but no operation id in Location header`)
    return { submitted: false, detail: 'edge did not return an operation id for the submission' }
  }
  console.log(`${tag} submission 202 accepted, polling operation ${submitOperationId}`)

  // This 202 only means the request was accepted, not that the submission
  // actually left draft — same async shape as the upload above, and the
  // same operation-status endpoint pattern applies. Confirmed against a
  // real incident: a target sat at in_review for 10 days while Partner
  // Center's own UI still showed the version "In draft" — extport had
  // treated the bare 202 as final and never checked further.
  const submitted = await pollOperation(
    `${API_BASE}/v1/products/${productId}/submissions/operations/${submitOperationId}`,
    headers,
    fetchImpl,
    poll,
  )
  if (!submitted) {
    console.log(`${tag} submission poll timed out after ${poll.attempts} attempts — treating 202 as submitted`)
    // Unlike the upload-validation timeout above, retrying here is NOT
    // safe: re-calling POST .../submissions while this exact operation is
    // still processing gets rejected with "InProgressSubmission" — a real
    // production incident (2026-08-05, both Twitter Blocker and Twitter
    // Exporter) where the timeout path above returned `waiting: true`, the
    // next reconcile tick retried from scratch, and that retry collided
    // with the still-in-flight first attempt. Nothing persists this
    // operation id across reconcile ticks to poll it again later, so the
    // 202 that got us this operation id is the only confirmation we can
    // safely act on — same as before this file started polling the
    // submission step at all.
    return { submitted: true }
  }
  if (submitted.status !== 'Succeeded') {
    console.log(`${tag} submission operation not Succeeded: ${JSON.stringify(submitted)}`)
    // Edge's busy signal surfaces here too — see the InProgressSubmission
    // comment on the submission POST above.
    if (submitted.errorCode === 'InProgressSubmission') {
      return { submitted: false, waiting: true, detail: 'Edge is still reviewing an earlier submission — will retry next reconcile' }
    }
    return { submitted: false, detail: `submission failed: ${submitted.errorCode ?? ''} ${truncate(submitted.message ?? '')}`.trim() }
  }
  // Once this operation itself reports Succeeded, Edge exposes no further
  // status query — see getState()'s inReview.known: false, always. This is
  // the strongest confirmation the public API can ever give that the
  // *request* went through; it can't confirm the submission stays healthy
  // afterward (a later rejection, or Microsoft's backend stalling past this
  // point, is invisible to any endpoint we have. Requested a status endpoint
  // upstream — microsoft/MicrosoftEdge-Extensions#696 — closed 2026-08-05,
  // "not on the current roadmap." Permanent limitation, not a pending fix.)
  //
  // Worth being precise about what Succeeded does NOT cover, because it has
  // now bitten twice in different ways. It means Microsoft accepted and
  // finished processing the request — not that the version entered review.
  // Edge validates listing completeness separately, and a version failing
  // that check simply stays "In draft" in Partner Center while this returns
  // submitted: true. Instagram Exporter (2026-08-08): v0.0.19 was pushed
  // right after `notifications` and `declarativeNetRequestWithHostAccess`
  // were added to the manifest, so Edge wanted a justification for each on
  // the Privacy page and had none. It sat in draft 10 days with v0.0.21
  // queued behind it, while extport reported in_review throughout.
  //
  // Nothing here can detect that, and nothing needs adding — there is no
  // endpoint to ask. The 10-day stale-review reminder (vs 3 elsewhere) is
  // the only backstop, and diagnosis means reading Partner Center's own
  // per-version status. Documented for tenants in
  // apps/docs/src/content/docs/stores/edge.md, since the fix is theirs to
  // make: fill in the justification when a release adds a permission.
  console.log(`${tag} submission confirmed succeeded`)
  return { submitted: true }
}

const UNOBSERVABLE: StoreState = { live: { known: false }, inReview: { known: false } }

async function getState(target: StoreTarget, fetchImpl: FetchLike): Promise<StoreState> {
  // Confirmed API gap: Partner Center has no endpoint to query live/pending
  // version at all. As a best-effort fallback, ask the same endpoint the
  // public store detail page uses — it can only tell us the *live* version
  // (review-in-progress state is never shown to consumers, so `inReview`
  // stays unobservable regardless). Any failure here — network error, an
  // unexpected response shape, the endpoint disappearing entirely — falls
  // back to the same `known: false` this always returned, so this can only
  // ever make Edge's state more informative, never less reliable. See
  // apps/api/src/reconcile/decide.ts's merge rule for what `known: false`
  // ("unobservable", preserve whatever we already knew) means downstream.
  //
  // This endpoint is keyed by the store-facing crx id, not the Partner
  // Center Product ID `submit()` needs (see StoreTarget) — falls back to
  // storeItemId for targets created before crxId existed as a field; those
  // predate this fallback anyway (storeItemId held the crx id back then).
  const crxId = target.crxId ?? target.storeItemId
  try {
    const res = await fetchImpl(`${STORE_DETAIL_URL}/${encodeURIComponent(crxId)}`)
    if (!res.ok) return UNOBSERVABLE
    const body = (await res.json()) as { version?: string }
    if (!body.version) return UNOBSERVABLE
    return { live: { known: true, version: body.version }, inReview: { known: false } }
  } catch {
    return UNOBSERVABLE
  }
}

/**
 * Edge Partner Center (ClientID + API key headers, keys expire every ~72
 * days — track `expiresAt` for rotation reminders). There is no "whoami"
 * endpoint, so verification probes a nonexistent product: bad credentials
 * → 401/403, valid credentials → 404 for the dummy id.
 */
export function createEdgeAdapter(
  fetchImpl: FetchLike = (i, o) => fetch(i, o),
  poll: PollOptions = DEFAULT_POLL,
): StoreAdapter<EdgeCredentials> {
  return {
    store: 'edge',
    async verifyCredentials(credentials): Promise<CredentialCheck> {
      const res = await fetchImpl(
        `${API_BASE}/v1/products/${PROBE_ID}/submissions/draft/package/operations/${PROBE_ID}`,
        { headers: edgeHeaders(credentials) },
      )
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: `edge api rejected the credentials: ${truncate(await res.text())}` }
      }
      if (res.status === 404 || res.ok) return { ok: true }
      throw new Error(`edge api unexpected response (${res.status})`)
    },
    getState: (_credentials, target) => getState(target, fetchImpl),
    submit: (credentials, target, artifact) => submit(credentials, target.storeItemId, artifact, fetchImpl, poll),
    // No withdraw: Partner Center's "Cancel submission" is UI-only, not part of the public API.
  }
}
