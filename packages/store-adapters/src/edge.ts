import type { CredentialCheck, EdgeCredentials, StoreAdapter } from './types'
import { notImplemented, truncate, type FetchLike } from './util'

const API_BASE = 'https://api.addons.microsoftedge.microsoft.com'
const PROBE_ID = '00000000-0000-0000-0000-000000000000'

export function edgeHeaders(credentials: EdgeCredentials): Record<string, string> {
  return {
    authorization: `ApiKey ${credentials.apiKey}`,
    'x-clientid': credentials.clientId,
  }
}

/**
 * Edge Partner Center v1.1 (ClientID + API key headers). There is no "whoami"
 * endpoint, so verification probes a nonexistent product: bad credentials
 * → 401/403, valid credentials → 404 for the dummy id.
 */
export function createEdgeAdapter(fetchImpl: FetchLike = (i, o) => fetch(i, o)): StoreAdapter<EdgeCredentials> {
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
    getState: notImplemented('edge', 'getState'),
    submit: notImplemented('edge', 'submit'),
  }
}
