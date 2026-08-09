/**
 * Reading Workers Analytics Engine.
 *
 * The `ANALYTICS` binding is write-only — its entire interface is
 * `writeDataPoint()` (see worker-configuration.d.ts). Queries have to go
 * through the SQL API over HTTP with an account-scoped API token, which is
 * why the rollup needs ANALYTICS_API_TOKEN while ingest needs nothing.
 *
 * Column layout is fixed by the single writeDataPoint call in
 * routes/analytics.ts. Named here once so the rollup's SQL reads as
 * something other than blob4/blob6.
 */
export const WAE_DATASET = 'extport_analytics'

export const COL = {
  extensionId: 'index1',
  installId: 'blob1',
  tenantId: 'blob2',
  browser: 'blob3',
  version: 'blob4',
  os: 'blob5',
  country: 'blob6',
  language: 'blob7',
} as const

/** The ping dimensions the rollup breaks down by, mapped to their columns. */
export const DIM_COLUMN = {
  version: COL.version,
  country: COL.country,
  language: COL.language,
  os: COL.os,
} as const

export type Dim = keyof typeof DIM_COLUMN

export interface WaeConfig {
  accountId: string
  apiToken: string
}

export type WaeQuery = (sql: string) => Promise<Record<string, string>[]>

/**
 * Every value comes back as a string, including counts — the caller converts.
 * Errors are surfaced rather than swallowed: a rollup that silently wrote
 * zeroes would look like every extension lost all its users overnight.
 */
export function createWaeQuery(config: WaeConfig, fetchImpl: typeof fetch = fetch): WaeQuery {
  return async (sql: string) => {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiToken}` },
      body: sql,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`analytics engine query failed (${res.status}): ${text.slice(0, 300)}`)
    let parsed: { data?: Record<string, string>[] }
    try {
      parsed = JSON.parse(text) as { data?: Record<string, string>[] }
    } catch {
      // The SQL API reports malformed queries as a plain-text 200, not JSON.
      throw new Error(`analytics engine returned a non-JSON response: ${text.slice(0, 300)}`)
    }
    return parsed.data ?? []
  }
}

/**
 * A half-open [start, end) range over one UTC day boundary, matching how the
 * D1 side derives `date` (isoDay = toISOString().slice(0,10), i.e. UTC). A
 * timezone mismatch here would shift whole days of pings between buckets.
 */
export function dayRange(startDay: string, endDayExclusive: string): string {
  return `timestamp >= toDateTime('${startDay} 00:00:00') AND timestamp < toDateTime('${endDayExclusive} 00:00:00')`
}

/**
 * `count(DISTINCT ...)` in Analytics Engine is a HyperLogLog estimate, and
 * rows can be sampled under load — `_sample_interval` is the weight each
 * surviving row carries. Distinct counts can't be sample-weighted (you can't
 * scale a set cardinality), so these are approximate by construction.
 *
 * Measured against D1 over 2026-08-07..08 before the cutover: 14 of 20
 * extensions matched exactly, worst deviation 0.42% on a 475-install
 * extension, 0.07% on the largest (14k). Every deviation was negative, which
 * points at genuinely dropped writes (writeDataPoint is fire-and-forget and
 * the Worker can be torn down first) rather than HLL noise, which would
 * scatter both ways. Acceptable for DAU/WAU; the exact figures the dashboard
 * needs long-term still come from the D1 rollup this feeds.
 */
export function distinctInstalls(alias: string): string {
  return `count(DISTINCT ${COL.installId}) AS ${alias}`
}
