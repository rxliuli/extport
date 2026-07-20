import type { CredentialCheck, EdgeCredentials, StoreAdapter, StoreState, SubmissionResult } from './types'
import { pollUntil, truncate, type FetchLike } from './util'

const API_BASE = 'https://api.addons.microsoftedge.microsoft.com'
const PROBE_ID = '00000000-0000-0000-0000-000000000000'

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
    return { submitted: false, detail: 'package validation still in progress after the poll window — will retry next reconcile' }
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

async function getState(): Promise<StoreState> {
  // Confirmed API gap: Edge has no endpoint to query live/pending version at
  // all. Omitting both fields (not returning null) tells the reconciler
  // "unobservable" so it preserves whatever it already knows from a prior
  // successful submit, rather than overwriting real state with a false
  // "nothing here" — see apps/api/src/reconcile/decide.ts's merge rule.
  return {}
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
    getState,
    submit: (credentials, productId, artifact) => submit(credentials, productId, artifact, fetchImpl, poll),
    // No withdraw: Partner Center's "Cancel submission" is UI-only, not part of the public API.
  }
}
