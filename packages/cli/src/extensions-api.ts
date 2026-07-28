export interface StoreTarget {
  store: string
  enabled: boolean
}

interface MatrixResponse {
  extensions: { id: string; targets: StoreTarget[] }[]
}

/** Same order as the --store enum everywhere else in the CLI — the matrix endpoint returns targets in insertion order, not this one. */
const STORE_ORDER = ['chrome', 'firefox', 'edge', 'safari']

/**
 * Only enabled targets — a disabled one was deliberately paused by the
 * tenant (dashboard toggle), and an unattended `extport push` with no
 * --store shouldn't resurrect it.
 */
export async function fetchEnabledTargets(
  apiUrl: string,
  apiKey: string,
  extensionRef: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoreTarget[]> {
  const res = await fetchImpl(new URL('/api/v1/extensions/matrix', apiUrl), { headers: { authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`could not fetch configured store targets (${res.status})`)
  const body = (await res.json()) as MatrixResponse
  const match = body.extensions.find((e) => e.id === extensionRef)
  if (!match) throw new Error(`extension "${extensionRef}" not found`)
  return match.targets.filter((t) => t.enabled).sort((a, b) => STORE_ORDER.indexOf(a.store) - STORE_ORDER.indexOf(b.store))
}
