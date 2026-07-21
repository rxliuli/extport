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

  const uploadRes = await fetchImpl(`${API_BASE}/v1/products/${productId}/submissions/draft/package`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/zip' },
    body: artifact,
  })
  if (uploadRes.status !== 202) {
    return { submitted: false, detail: `package upload rejected (${uploadRes.status}): ${truncate(await uploadRes.text())}` }
  }
  const uploadOperationId = operationIdFromLocation(uploadRes)
  if (!uploadOperationId) {
    return { submitted: false, detail: 'edge did not return an operation id for the package upload' }
  }

  const validated = await pollOperation(
    `${API_BASE}/v1/products/${productId}/submissions/draft/package/operations/${uploadOperationId}`,
    headers,
    fetchImpl,
    poll,
  )
  if (!validated) {
    // Not a failure — validation just outlasted our poll window. `waiting`
    // keeps the version queued without recording a target error each tick.
    return { submitted: false, waiting: true, detail: 'package validation still in progress after the poll window — will retry next reconcile' }
  }
  if (validated.status !== 'Succeeded') {
    return { submitted: false, detail: `package validation failed: ${validated.errorCode ?? ''} ${truncate(validated.message ?? '')}`.trim() }
  }

  const submitRes = await fetchImpl(`${API_BASE}/v1/products/${productId}/submissions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ notes: 'Submitted automatically by extport.' }),
  })
  if (submitRes.status !== 202) {
    return { submitted: false, detail: `submission rejected (${submitRes.status}): ${truncate(await submitRes.text())}` }
  }
  // Edge exposes no further status query once a submission enters certification —
  // this 202 is the strongest confirmation signal the public API will ever give us
  // (confirmed 2026-07 research: there is no GET-product/status endpoint at all).
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
