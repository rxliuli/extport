import { eq, lt, sql } from 'drizzle-orm'
import { analyticsDaily, analyticsPings, type Db } from '../db'
import { addDays, isoDay } from '../lib/dates'

// Nightly analytics rollup — see docs/analytics-design.md. Everything here
// is a deterministic recompute (delete + insert-select, or upsert-set), so
// re-running for the same day is always safe.
//
// Processes yesterday only. A missed night leaves a hole that can be
// repaired manually by calling this with `now` set to the day after the
// hole while the raw window still covers it (dau/wau/mau/installs
// recompute exactly; only the departure snapshot drifts with install
// state, the documented cost of deriving it from last_seen).
export async function runAnalyticsRollup(db: Db, now: Date = new Date()): Promise<{ day: string }> {
  const yesterday = isoDay(addDays(now, -1))
  const wauStart = isoDay(addDays(now, -7)) // 7-day window ending yesterday
  const mauStart = isoDay(addDays(now, -30)) // 30-day window ending yesterday
  const departedDay = isoDay(addDays(now, -31)) // last-seen day now 30 full days silent
  const pruneBefore = isoDay(addDays(now, -90))

  // DAU, headline + one row per dimension value. count(distinct install_id)
  // so raced duplicate raw rows can never inflate anything.
  await db.delete(analyticsDaily).where(eq(analyticsDaily.date, yesterday))
  await db.run(sql`
    INSERT INTO analytics_daily (tenant_id, extension_id, date, browser, dim, dim_value, dau)
    SELECT tenant_id, extension_id, date, browser, 'total', '', count(DISTINCT install_id)
    FROM analytics_pings WHERE date = ${yesterday}
    GROUP BY tenant_id, extension_id, browser
  `)
  for (const dim of ['version', 'country', 'language', 'os'] as const) {
    const column = sql.raw(dim === 'version' ? 'version' : dim)
    await db.run(sql`
      INSERT INTO analytics_daily (tenant_id, extension_id, date, browser, dim, dim_value, dau)
      SELECT tenant_id, extension_id, date, browser, ${dim}, coalesce(${column}, 'unknown'), count(DISTINCT install_id)
      FROM analytics_pings WHERE date = ${yesterday}
      GROUP BY tenant_id, extension_id, browser, coalesce(${column}, 'unknown')
    `)
    // Per-dimension WAU, same window and exactness argument as the headline
    // WAU below. Upsert: a dim value seen this week but not yesterday gets
    // its own row here (dau 0, wau > 0) — the breakdown charts read wau, so
    // a value must not vanish just because it skipped a day. An install
    // whose value changed mid-week (country hop, version update) counts
    // once per value; shares are computed within the dimension.
    await db.run(sql`
      INSERT INTO analytics_daily (tenant_id, extension_id, date, browser, dim, dim_value, wau)
      SELECT tenant_id, extension_id, ${yesterday}, browser, ${dim}, coalesce(${column}, 'unknown'), count(DISTINCT install_id)
      FROM analytics_pings WHERE date >= ${wauStart} AND date <= ${yesterday}
      GROUP BY tenant_id, extension_id, browser, coalesce(${column}, 'unknown')
      ON CONFLICT (extension_id, date, browser, dim, dim_value)
      DO UPDATE SET wau = excluded.wau
    `)
  }

  // Rolling 7-day WAU ending yesterday — from raw pings, not the mutable
  // last_seen pointer, so it's exact and immune to the same-day snapshot
  // undercount MAU carries. The window always sits inside the 90-day raw
  // window, and the permanent row is written while raw is still here.
  await db.run(sql`
    INSERT INTO analytics_daily (tenant_id, extension_id, date, browser, dim, dim_value, wau)
    SELECT tenant_id, extension_id, ${yesterday}, browser, 'total', '', count(DISTINCT install_id)
    FROM analytics_pings WHERE date >= ${wauStart} AND date <= ${yesterday}
    GROUP BY tenant_id, extension_id, browser
    ON CONFLICT (extension_id, date, browser, dim, dim_value)
    DO UPDATE SET wau = excluded.wau
  `)

  // Installs: first_seen is immutable, so this recomputes exactly.
  await db.run(sql`
    INSERT INTO analytics_daily (tenant_id, extension_id, date, browser, dim, dim_value, installs)
    SELECT tenant_id, extension_id, first_seen, browser, 'total', '', count(*)
    FROM analytics_installs WHERE first_seen = ${yesterday}
    GROUP BY tenant_id, extension_id, browser
    ON CONFLICT (extension_id, date, browser, dim, dim_value)
    DO UPDATE SET installs = excluded.installs
  `)

  // Rolling 30-day MAU as of yesterday — from raw pings, exactly like WAU
  // (the 30-day window always sits inside the 90-day raw window). It used
  // to count analytics_installs.last_seen, whose forward drift between
  // midnight and this cron silently dropped same-day actives from the
  // snapshot. Nothing displays mau today (every surface reads wau), but
  // cross-day uniques can't be rebuilt after the raw window closes, so
  // the permanent record keeps accruing.
  await db.run(sql`
    INSERT INTO analytics_daily (tenant_id, extension_id, date, browser, dim, dim_value, mau)
    SELECT tenant_id, extension_id, ${yesterday}, browser, 'total', '', count(DISTINCT install_id)
    FROM analytics_pings WHERE date >= ${mauStart} AND date <= ${yesterday}
    GROUP BY tenant_id, extension_id, browser
    ON CONFLICT (extension_id, date, browser, dim, dim_value)
    DO UPDATE SET mau = excluded.mau
  `)

  // Departures, attributed to the last-seen day and only now confirmed —
  // an install whose last_seen is exactly 31 days back has been silent for
  // 30 full days. Each install matches this predicate on exactly one cron
  // day (any later ping moves last_seen and it never matches again), and
  // the count lands on the historical row, upserted in case that day's
  // row predates analytics or was pruned.
  await db.run(sql`
    INSERT INTO analytics_daily (tenant_id, extension_id, date, browser, dim, dim_value, departures)
    SELECT tenant_id, extension_id, last_seen, browser, 'total', '', count(*)
    FROM analytics_installs WHERE last_seen = ${departedDay}
    GROUP BY tenant_id, extension_id, browser
    ON CONFLICT (extension_id, date, browser, dim, dim_value)
    DO UPDATE SET departures = excluded.departures
  `)

  // The 90-day raw window is our own policy, enforced by us, not a platform.
  await db.delete(analyticsPings).where(lt(analyticsPings.date, pruneBefore))

  return { day: yesterday }
}
