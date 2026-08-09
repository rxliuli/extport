import { eq, lt, sql, type SQL } from 'drizzle-orm'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
import { analyticsDaily, analyticsPings, type Db } from '../db'
import { addDays, isoDay } from '../lib/dates'
import { COL, DIM_COLUMN, dayRange, distinctInstalls, WAE_DATASET, type Dim, type WaeQuery } from './wae'

// drizzle's own db.batch() can't carry db.run(sql`...`) statements — only
// real query-builder calls (insert/update/delete/select) have the internal
// shape it expects; a raw sql`...` wrapped in .run() throws inside batch()
// (confirmed the hard way, via a failing test). D1's own batch() has no such
// restriction, so build every statement down to a bound D1PreparedStatement
// ourselves and hand the array to the native client instead.
const dialect = new SQLiteAsyncDialect()
function toD1(db: Db, query: SQL | { toSQL(): { sql: string; params: unknown[] } }) {
  const { sql: text, params } = 'toSQL' in query ? query.toSQL() : dialect.sqlToQuery(query)
  return db.$client.prepare(text).bind(...params)
}

/** One grouped row of activity, shared by the headline and per-dimension shapes. */
interface ActivityRow {
  tenantId: string
  extensionId: string
  browser: string
  dimValue: string
  count: number
}

function toActivityRows(rows: Record<string, string>[], hasDimValue: boolean): ActivityRow[] {
  return rows.map((r) => ({
    tenantId: r.tenant_id ?? '',
    extensionId: r.extension_id ?? '',
    browser: r.browser ?? '',
    // Mirrors the D1 side's coalesce(col, 'unknown'): a ping whose os or
    // language couldn't be parsed still has to land in some bucket.
    dimValue: hasDimValue ? (r.dim_value || 'unknown') : '',
    count: Number(r.n ?? 0),
  }))
}

/**
 * DAU/WAU now come from Analytics Engine rather than a scan over
 * analytics_pings — that scan (one per day, one per 7-day window, times five
 * dimensions) was the bulk of D1's daily row reads. See docs/analytics-design.md.
 */
async function readActivity(waeQuery: WaeQuery, where: string, dim: Dim | null): Promise<ActivityRow[]> {
  const dimSelect = dim ? `, ${DIM_COLUMN[dim]} AS dim_value` : ''
  const dimGroup = dim ? `, ${DIM_COLUMN[dim]}` : ''
  const rows = await waeQuery(`
    SELECT ${COL.tenantId} AS tenant_id, ${COL.extensionId} AS extension_id, ${COL.browser} AS browser${dimSelect},
           ${distinctInstalls('n')}
    FROM ${WAE_DATASET}
    WHERE ${where}
    GROUP BY tenant_id, extension_id, browser${dimGroup}
  `)
  return toActivityRows(rows, dim !== null)
}

/** Upsert one metric column without disturbing the others already on the row. */
function upsertMetric(db: Db, metric: 'dau' | 'wau', date: string, dim: string, rows: ActivityRow[]) {
  return rows.map((r) =>
    toD1(
      db,
      sql`
        INSERT INTO analytics_daily (tenant_id, extension_id, date, browser, dim, dim_value, ${sql.raw(metric)})
        VALUES (${r.tenantId}, ${r.extensionId}, ${date}, ${r.browser}, ${dim}, ${r.dimValue}, ${r.count})
        ON CONFLICT (extension_id, date, browser, dim, dim_value)
        DO UPDATE SET ${sql.raw(metric)} = excluded.${sql.raw(metric)}
      `,
    ),
  )
}

// Nightly analytics rollup — see docs/analytics-design.md. Everything here
// is a deterministic recompute (delete + insert-select, or upsert-set), so
// re-running for the same day is always safe.
//
// Processes yesterday only. A missed night leaves a hole that can be
// repaired manually by calling this with `now` set to the day after the
// hole while the raw window still covers it (dau/wau/installs recompute
// exactly; only the departure snapshot drifts with install state, the
// documented cost of deriving it from last_seen).
//
// Split across two stores on purpose: the ping stream lives in Analytics
// Engine (high-frequency, immutable, 90-day platform cap), install state and
// this permanent rollup live in D1 (mutable first_seen/last_seen, queried up
// to 5 years back — far past anything WAE retains).
export async function runAnalyticsRollup(db: Db, now: Date = new Date(), waeQuery?: WaeQuery): Promise<{ day: string }> {
  const yesterday = isoDay(addDays(now, -1))
  const today = isoDay(now)
  const wauStart = isoDay(addDays(now, -7)) // 7-day window ending yesterday
  const departedDay = isoDay(addDays(now, -31)) // last-seen day now 30 full days silent
  const pruneBefore = isoDay(addDays(now, -90))

  // Half-open ranges: `date = yesterday` and `date <= yesterday` both mean
  // "up to but not including today" once expressed as timestamps.
  const dayWhere = dayRange(yesterday, today)
  const weekWhere = dayRange(wauStart, today)

  // Read everything from WAE first. Doing this before the batch keeps the D1
  // write itself atomic — a failed query aborts the whole rollup rather than
  // leaving analytics_daily half-rewritten.
  const dims = ['version', 'country', 'language', 'os'] as const
  const [headlineDau, headlineWau, ...dimResults] = waeQuery
    ? await Promise.all([
        readActivity(waeQuery, dayWhere, null),
        readActivity(waeQuery, weekWhere, null),
        ...dims.flatMap((dim) => [readActivity(waeQuery, dayWhere, dim), readActivity(waeQuery, weekWhere, dim)]),
      ])
    : [[], [], ...dims.flatMap(() => [[], []])]

  const dimStatements = dims.flatMap((dim, i) => [
    ...upsertMetric(db, 'dau', yesterday, dim, dimResults[i * 2] ?? []),
    ...upsertMetric(db, 'wau', yesterday, dim, dimResults[i * 2 + 1] ?? []),
  ])

  // Everything below lands in one D1 batch — a single transaction. Un-
  // batched, this was delete-then-fourteen-separate-inserts: a dashboard
  // read racing the cron could land between the delete and the last insert
  // and see "yesterday" partially or entirely missing, rendering as a crash
  // to zero on the most recent day until the next read.
  const statements = [
    toD1(db, db.delete(analyticsDaily).where(eq(analyticsDaily.date, yesterday))),
    ...upsertMetric(db, 'dau', yesterday, 'total', headlineDau ?? []),
    ...dimStatements,
    // Rolling 7-day WAU ending yesterday — from raw pings, not the mutable
    // last_seen pointer, so it's immune to the same-day snapshot undercount.
    // The window always sits inside WAE's 90-day retention, and the permanent
    // row is written while those pings are still queryable.
    ...upsertMetric(db, 'wau', yesterday, 'total', headlineWau ?? []),
    // Installs and departures stay on D1: both read analytics_installs, whose
    // first_seen/last_seen are mutable state. WAE only stores an immutable
    // event stream and has no equivalent.
    //
    // Installs: first_seen is immutable, so this recomputes exactly.
    toD1(
      db,
      sql`
        INSERT INTO analytics_daily (tenant_id, extension_id, date, browser, dim, dim_value, installs)
        SELECT tenant_id, extension_id, first_seen, browser, 'total', '', count(*)
        FROM analytics_installs WHERE first_seen = ${yesterday}
        GROUP BY tenant_id, extension_id, browser
        ON CONFLICT (extension_id, date, browser, dim, dim_value)
        DO UPDATE SET installs = excluded.installs
      `,
    ),
    // Departures, attributed to the last-seen day and only now confirmed —
    // an install whose last_seen is exactly 31 days back has been silent for
    // 30 full days. Each install matches this predicate on exactly one cron
    // day (any later ping moves last_seen and it never matches again), and
    // the count lands on the historical row, upserted in case that day's
    // row predates analytics or was pruned.
    toD1(
      db,
      sql`
        INSERT INTO analytics_daily (tenant_id, extension_id, date, browser, dim, dim_value, departures)
        SELECT tenant_id, extension_id, last_seen, browser, 'total', '', count(*)
        FROM analytics_installs WHERE last_seen = ${departedDay}
        GROUP BY tenant_id, extension_id, browser
        ON CONFLICT (extension_id, date, browser, dim, dim_value)
        DO UPDATE SET departures = excluded.departures
      `,
    ),
    // The 90-day raw window is our own policy, enforced by us, not a platform.
    // Kept while the dual-write runs so the two sources stay comparable; it
    // goes away with the analytics_pings write itself.
    toD1(db, db.delete(analyticsPings).where(lt(analyticsPings.date, pruneBefore))),
  ]

  await db.$client.batch(statements)

  return { day: yesterday }
}
