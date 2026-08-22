import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { analyticsDaily, analyticsInstalls, extensions } from '../db'
import { isoDay } from '../lib/dates'
import { parseBrowser, parseOs } from '../lib/user-agent'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireAuth, type AppEnv } from '../middleware/auth'

// Analytics wire protocol: a single daily ping — install/update/active/
// departure are all server-side inferences. See docs/analytics-design.md.

// ---- Public ingest (called from extension backgrounds, CORS-open) ----

export const analyticsPublicRoutes = new Hono<AppEnv>()
analyticsPublicRoutes.use('*', cors())

const pingBodySchema = v.object({
  installId: v.pipe(v.string('installId is required'), v.trim(), v.minLength(8), v.maxLength(64)),
  extensionId: v.pipe(v.string('extensionId is required'), v.trim(), v.minLength(1)),
  version: v.pipe(v.string('version is required'), v.trim(), v.minLength(1), v.maxLength(32)),
  language: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(35))),
})

analyticsPublicRoutes.post(
  '/ping',
  describeRoute({
    summary: 'Daily analytics ping',
    description:
      'The only analytics event. At most one counts per install per UTC day (the server ignores extras). Browser/OS derive from the User-Agent, country from the request — the payload deliberately carries no more than this.',
    tags: ['Analytics'],
    security: [],
    responses: { 204: { description: 'Accepted (or ignored — the response never distinguishes)' } },
  }),
  validator('json', pingBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const body = c.req.valid('json')

    // Unknown extensions get the same 204 as accepted pings: a public,
    // unauthenticated endpoint should not be an extension-id oracle.
    const [extension] = await db.select().from(extensions).where(eq(extensions.id, body.extensionId))
    if (!extension) return c.body(null, 204)

    const today = isoDay(new Date())
    const ua = c.req.header('user-agent')
    // Automation filter: CI e2e suites load production builds into headless
    // browsers, and every test context is a fresh "install" — one workflow
    // run injected ~20 phantom US/Linux installs on day zero. No real user
    // runs HeadlessChrome; drop silently. (Fleet convention: e2e launches
    // with --headless=new, which is also the only mode that loads MV3
    // extensions — headed-under-xvfb CI would evade this filter.)
    if (ua && /HeadlessChrome/i.test(ua)) return c.body(null, 204)
    // Same spirit: a browser fetch always carries a User-Agent, so a UA-less
    // ping is curl or a script — the one 'other'-browser install ever
    // recorded was exactly that (a manual endpoint test). Drop silently.
    if (!ua) return c.body(null, 204)
    const browser = parseBrowser(ua)
    // And the UA-carrying variant of the same thing: an extension background
    // fetch always identifies its browser family in the UA, so a UA that
    // parses to 'other' is not an extension — it's a script or an embedded
    // WebView replaying the ping. Real incident (2026-08-09): a prober hit
    // two extensions with a WebView-style iOS UA (iPhone token, no Safari/
    // token) and a placeholder version "1.0", minting a phantom install and
    // a "1.0" series in charts for an extension with no iOS build at all.
    if (browser === 'other') return c.body(null, 204)

    // Server-side idempotency gate: the SDK already dedups per UTC day, but
    // a misbehaving client must not be able to inflate anything.
    const [install] = await db
      .select()
      .from(analyticsInstalls)
      .where(and(eq(analyticsInstalls.extensionId, extension.id), eq(analyticsInstalls.installId, body.installId)))
    if (install?.lastSeen === today) return c.body(null, 204)

    const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf
    const os = parseOs(ua)
    const country = cf?.country?.toLowerCase() ?? null
    const language = body.language?.toLowerCase() || null

    // The install row is the only thing D1 still stores per ping: mutable
    // state (first_seen/last_seen) that an append-only event store can't
    // hold. The ping itself goes to WAE below.
    //
    // These two writes are deliberately not atomic, and can't be — they're
    // different systems. A torn-down Worker can leave an install row whose
    // ping never reached WAE, which undercounts that day's DAU by one while
    // installs stays right. That is the same ~0.07% drift measured across the
    // dual-write period, and the reason DAU/WAU are described as approximate.
    await db
      .insert(analyticsInstalls)
      .values({
        extensionId: extension.id,
        installId: body.installId,
        tenantId: extension.tenantId,
        browser,
        firstSeen: today,
        lastSeen: today,
        lastVersion: body.version,
      })
      // Two same-day pings racing past the gate resolve here; the duplicate
      // data point they leave in WAE is neutralized by the rollup's
      // count(DISTINCT install_id).
      .onConflictDoUpdate({
        target: [analyticsInstalls.extensionId, analyticsInstalls.installId],
        set: { lastSeen: today, lastVersion: body.version },
      })

    c.env.ANALYTICS.writeDataPoint({
      indexes: [extension.id],
      blobs: [body.installId, extension.tenantId, browser, body.version, os, country, language],
    })

    return c.body(null, 204)
  },
)

// ---- Tenant read endpoints (dashboard charts) ----

export const analyticsTenantRoutes = new Hono<AppEnv>()
analyticsTenantRoutes.use('*', requireAuth, requireActiveTenant)

/**
 * Seconds until safely past the next nightly rollup — everything these
 * endpoints read comes from analytics_daily, which changes only when that
 * cron runs (00:15 UTC, ANALYTICS_ROLLUP_CRON), so a response stays correct
 * until then.
 *
 * The margin past 00:15 is the point. Expiring exactly at 00:15 means a
 * request landing while the rollup is still running re-reads yesterday's
 * numbers and caches them for another full day — turning a one-minute delay
 * into a day-long staleness. Between midnight and 00:30 the answer is
 * deliberately short-lived instead, since whether the rollup has finished is
 * unknowable from here.
 *
 * A response cached inside that window is honest, not merely tolerable,
 * because `through` (below) shares the same boundary: the snapshot simply
 * ends a day earlier, and the new day appears at most ~15 minutes after the
 * rollup lands.
 */
export function secondsUntilNextRollup(now: Date = new Date()): number {
  const next = new Date(now)
  next.setUTCHours(0, 30, 0, 0)
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
  return Math.ceil((next.getTime() - now.getTime()) / 1000)
}

/**
 * The last day whose rollup is known to be complete — yesterday once safely
 * past the 00:15 UTC cron, the day before while the rollup may still be
 * running. Clock-derived on purpose, from the same 00:30 boundary the cache
 * header uses: a row's absence can't distinguish "zero activity" from "not
 * computed yet", so the charts need this told to them explicitly. Serving it
 * from the server keeps the rule in one place and on the one clock that
 * actually runs the cron.
 *
 * The series endpoints return it as `through`: the chart's x-axis ends
 * there, so a pre-rollup response shows a window ending one day earlier
 * instead of drawing the missing day as a cliff to zero (a real incident:
 * a viewer who loaded the dashboard just after UTC midnight watched
 * yesterday's ~29k DAU render as 0).
 */
export function latestRolledUpDay(now: Date = new Date()): string {
  const preRollup = now.getUTCHours() === 0 && now.getUTCMinutes() < 30
  return isoDay(new Date(now.getTime() - (preRollup ? 2 : 1) * 24 * 60 * 60 * 1000))
}

// `private` is load-bearing: these are per-tenant figures, and a shared
// cache holding them would serve one tenant's numbers to another.
analyticsTenantRoutes.use('*', async (c, next) => {
  await next()
  // Only successful reads are cacheable — a 401/404 must not be remembered,
  // least of all for a day.
  if (c.res.status === 200) {
    c.res.headers.set('cache-control', `private, max-age=${secondsUntilNextRollup()}`)
  }
})

interface DimensionRow {
  value: string
  wau: number
}

/**
 * Top values by weekly actives, with the tail folded into a single `null`
 * entry — the shape the breakdown cards render. Shares are computed within
 * the dimension, so they always sum to 1 even though a value can appear in
 * several dimensions.
 *
 * Zero-wau rows are dropped rather than ranked: a dimension value seen
 * earlier in the week but not in the current window still has a row (the
 * rollup upserts wau onto rows whose dau is 0), and listing it at 0% would
 * imply the card is showing something it isn't.
 */
export interface DimensionShare {
  /** null is the folded tail ("Other"), never a real dimension value. */
  value: string | null
  wau: number
  share: number
}

export function topShares(rows: DimensionRow[], topN = 5): DimensionShare[] {
  const ranked = rows.filter((r) => r.wau > 0).sort((a, b) => b.wau - a.wau)
  const total = ranked.reduce((sum, r) => sum + r.wau, 0)
  if (total === 0) return []
  const top = ranked.slice(0, topN)
  const otherWau = total - top.reduce((sum, r) => sum + r.wau, 0)
  const shares: DimensionShare[] = top.map((r) => ({ value: r.value, wau: r.wau, share: r.wau / total }))
  if (otherWau > 0) shares.push({ value: null, wau: otherWau, share: otherWau / total })
  return shares
}

async function ownedExtension(c: Context<AppEnv>) {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const id = c.req.query('extension') ?? ''
  const [extension] = await db
    .select()
    .from(extensions)
    .where(and(eq(extensions.id, id), eq(extensions.tenantId, tenant.id)))
  return extension
}

analyticsTenantRoutes.get(
  '/series',
  describeRoute({
    summary: 'Daily analytics series',
    description:
      "Rows from the permanent rollup for one extension: ?dim=total (headline dau/wau/mau/installs/departures) or version/country/language/os (dau + wau). ?days= bounds the window (default 90, max 1830). `through` is the last fully-rolled-up day — charts should end their axis there; a day past it is not yet computed, not zero. Departures live on the last-seen day and are only present once confirmed — the trailing 30 days legitimately show none.",
    tags: ['Analytics'],
    responses: { 200: { description: 'OK' }, 404: { description: 'Extension not found' } },
  }),
  async (c) => {
    const db = c.get('db')
    const extension = await ownedExtension(c)
    if (!extension) return c.json({ error: 'extension not found' }, 404)

    const dim = c.req.query('dim') ?? 'total'
    if (!['total', 'version', 'country', 'language', 'os'].includes(dim)) {
      return c.json({ error: 'dim must be one of total, version, country, language, os' }, 400)
    }
    const days = Math.min(Number.parseInt(c.req.query('days') ?? '90', 10) || 90, 1830)
    const from = isoDay(new Date(Date.now() - days * 24 * 60 * 60 * 1000))

    const rows = await db
      .select({
        date: analyticsDaily.date,
        browser: analyticsDaily.browser,
        dimValue: analyticsDaily.dimValue,
        dau: analyticsDaily.dau,
        wau: analyticsDaily.wau,
        installs: analyticsDaily.installs,
        departures: analyticsDaily.departures,
        mau: analyticsDaily.mau,
      })
      .from(analyticsDaily)
      .where(
        and(
          eq(analyticsDaily.extensionId, extension.id),
          eq(analyticsDaily.dim, dim as 'total'),
          gte(analyticsDaily.date, from),
        ),
      )
      .orderBy(analyticsDaily.date)
    return c.json({ rows, through: latestRolledUpDay() })
  },
)

analyticsTenantRoutes.get(
  '/overview',
  describeRoute({
    summary: 'Analytics overview',
    description:
      'Weekly actives, all-time installs, and the current version distribution — all derived from the same rollup /series reads, so this can never disagree with the charts. Empty until the first nightly rollup runs for this extension (never live-queried install state, which used to be able to show numbers the charts had no way to display yet).',
    tags: ['Analytics'],
    responses: { 200: { description: 'OK' }, 404: { description: 'Extension not found' } },
  }),
  async (c) => {
    const db = c.get('db')
    const extension = await ownedExtension(c)
    if (!extension) return c.json({ error: 'extension not found' }, 404)

    const [latest] = await db
      .select({ date: analyticsDaily.date })
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.extensionId, extension.id), eq(analyticsDaily.dim, 'total')))
      .orderBy(desc(analyticsDaily.date))
      .limit(1)
    if (!latest) return c.json({ weeklyActives: 0, allTimeInstalls: 0, versions: [] })

    // WAU is the only activity figure any surface shows — one metric, the
    // same one the chart plots, exact from raw pings.
    const [active] = await db
      .select({ weeklyActives: sql<number>`sum(${analyticsDaily.wau})` })
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.extensionId, extension.id), eq(analyticsDaily.dim, 'total'), eq(analyticsDaily.date, latest.date)))
    const [allTime] = await db
      .select({ allTimeInstalls: sql<number>`sum(${analyticsDaily.installs})` })
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.extensionId, extension.id), eq(analyticsDaily.dim, 'total')))
    // Version share reads wau over wau — same metric as the headline, both
    // exact, so a share can never exceed 100%. (It used to divide yesterday's
    // per-version DAU by the MAU snapshot: cross-granularity, and the
    // snapshot's same-day undercount pushed shares past 100% on day-one
    // extensions.)
    const versions = await db
      .select({ version: analyticsDaily.dimValue, weeklyUsers: sql<number>`sum(${analyticsDaily.wau})` })
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.extensionId, extension.id), eq(analyticsDaily.dim, 'version'), eq(analyticsDaily.date, latest.date)))
      .groupBy(analyticsDaily.dimValue)
      .orderBy(sql`sum(${analyticsDaily.wau}) desc`)

    // The breakdown cards are a snapshot, not a series: each shows the share
    // of weekly actives per value on the latest day, because wau is already a
    // rolling 7-day figure. They used to be three /series?dim= reads of a
    // week each — ~3,500 rows over the wire for ~18 that survived, since the
    // client kept only the last day. Ranking here also pins all three cards
    // and the headline to one `latest.date`, which separate requests couldn't
    // guarantee across a rollup.
    const breakdownRows = await db
      .select({ dim: analyticsDaily.dim, value: analyticsDaily.dimValue, wau: sql<number>`sum(${analyticsDaily.wau})` })
      .from(analyticsDaily)
      .where(
        and(
          eq(analyticsDaily.extensionId, extension.id),
          inArray(analyticsDaily.dim, ['country', 'language', 'os']),
          eq(analyticsDaily.date, latest.date),
        ),
      )
      .groupBy(analyticsDaily.dim, analyticsDaily.dimValue)

    const grouped = { country: [] as DimensionRow[], language: [] as DimensionRow[], os: [] as DimensionRow[] }
    for (const row of breakdownRows) {
      const bucket = grouped[row.dim as keyof typeof grouped]
      if (bucket) bucket.push({ value: row.value, wau: row.wau })
    }

    return c.json({
      weeklyActives: active?.weeklyActives ?? 0,
      allTimeInstalls: allTime?.allTimeInstalls ?? 0,
      versions,
      country: topShares(grouped.country),
      language: topShares(grouped.language),
      os: topShares(grouped.os),
    })
  },
)

// ---- Fleet-wide (cross-extension) views — the /analytics dashboard page ----
//
// version/country/language/os breakdowns don't generalize across extensions
// (a version string means nothing outside the product it belongs to), so
// only the two things that stay meaningful fleet-wide are exposed here:
// totals over time, and a per-extension breakdown as a ranked list rather
// than more chart series (see docs discussion — one line per extension
// stops being readable well before a real fleet's extension count).

analyticsTenantRoutes.get(
  '/fleet/overview',
  describeRoute({
    summary: 'Fleet-wide analytics overview',
    description:
      'Same shape as /overview but summed across every extension the tenant owns — derived from the same rollup /fleet/series reads, so this can never disagree with the fleet chart the way a live install-state query could.',
    tags: ['Analytics'],
    responses: { 200: { description: 'OK' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')

    const [latest] = await db
      .select({ date: analyticsDaily.date })
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.tenantId, tenant.id), eq(analyticsDaily.dim, 'total')))
      .orderBy(desc(analyticsDaily.date))
      .limit(1)
    if (!latest) return c.json({ weeklyActives: 0, allTimeInstalls: 0, extensionsReporting: 0 })

    const [active] = await db
      .select({ weeklyActives: sql<number>`sum(${analyticsDaily.wau})` })
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.tenantId, tenant.id), eq(analyticsDaily.dim, 'total'), eq(analyticsDaily.date, latest.date)))
    const [allTime] = await db
      .select({ allTimeInstalls: sql<number>`sum(${analyticsDaily.installs})` })
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.tenantId, tenant.id), eq(analyticsDaily.dim, 'total')))
    const [reporting] = await db
      .select({ extensionsReporting: sql<number>`count(distinct ${analyticsDaily.extensionId})` })
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.tenantId, tenant.id), eq(analyticsDaily.dim, 'total')))

    return c.json({
      weeklyActives: active?.weeklyActives ?? 0,
      allTimeInstalls: allTime?.allTimeInstalls ?? 0,
      extensionsReporting: reporting?.extensionsReporting ?? 0,
    })
  },
)

analyticsTenantRoutes.get(
  '/fleet/series',
  describeRoute({
    summary: 'Fleet-wide daily analytics series',
    description: 'Same row shape as /series?dim=total, summed across every extension the tenant owns instead of one. ?days= bounds the window (default 90, max 1830). `through` is the last fully-rolled-up day, same as /series.',
    tags: ['Analytics'],
    responses: { 200: { description: 'OK' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')

    const days = Math.min(Number.parseInt(c.req.query('days') ?? '90', 10) || 90, 1830)
    const from = isoDay(new Date(Date.now() - days * 24 * 60 * 60 * 1000))

    const rows = await db
      .select({
        date: analyticsDaily.date,
        browser: analyticsDaily.browser,
        // dim='total' rows always carry '' here (never read, just present
        // for shape-compatibility with /series so the dashboard can reuse
        // the same chart-building code for both).
        dimValue: sql<string>`''`,
        dau: sql<number>`sum(${analyticsDaily.dau})`,
        wau: sql<number>`sum(${analyticsDaily.wau})`,
        installs: sql<number>`sum(${analyticsDaily.installs})`,
        departures: sql<number>`sum(${analyticsDaily.departures})`,
        mau: sql<number>`sum(${analyticsDaily.mau})`,
      })
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.tenantId, tenant.id), eq(analyticsDaily.dim, 'total'), gte(analyticsDaily.date, from)))
      .groupBy(analyticsDaily.date, analyticsDaily.browser)
      .orderBy(analyticsDaily.date)
    return c.json({ rows, through: latestRolledUpDay() })
  },
)

analyticsTenantRoutes.get(
  '/fleet/extensions',
  describeRoute({
    summary: 'Per-extension analytics ranking',
    description:
      'One row per extension that has ever reported analytics, sorted by weekly actives — the "list" half of the fleet-wide page, since per-extension detail belongs in a table, not as more chart lines. Derived from the same rollup every other analytics endpoint reads, so an extension only appears once its own first nightly rollup has run, same as its own Analytics tab would show.',
    tags: ['Analytics'],
    responses: { 200: { description: 'OK' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')

    const extensionRows = await db.select({ id: extensions.id, name: extensions.name }).from(extensions).where(eq(extensions.tenantId, tenant.id))

    // Fetched once and reduced here rather than per-extension SQL: each
    // extension's weekly-actives figure needs sum(wau) on *its own* latest
    // rolled-up date specifically (not a shared tenant-wide date — a
    // newly-onboarded extension can lag behind the rest of the fleet by a
    // rollup cycle or more), which isn't a single GROUP BY.
    const totalRows = await db
      .select({ extensionId: analyticsDaily.extensionId, date: analyticsDaily.date, wau: analyticsDaily.wau, installs: analyticsDaily.installs })
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.tenantId, tenant.id), eq(analyticsDaily.dim, 'total')))

    const latestDateById = new Map<string, string>()
    const allTimeById = new Map<string, number>()
    for (const row of totalRows) {
      allTimeById.set(row.extensionId, (allTimeById.get(row.extensionId) ?? 0) + row.installs)
      const currentLatest = latestDateById.get(row.extensionId)
      if (!currentLatest || row.date > currentLatest) latestDateById.set(row.extensionId, row.date)
    }
    const activeById = new Map<string, number>()
    for (const row of totalRows) {
      if (row.date !== latestDateById.get(row.extensionId)) continue
      activeById.set(row.extensionId, (activeById.get(row.extensionId) ?? 0) + row.wau)
    }

    const items = extensionRows
      .map((e) => ({
        extensionId: e.id,
        name: e.name,
        weeklyActives: activeById.get(e.id) ?? 0,
        allTimeInstalls: allTimeById.get(e.id) ?? 0,
      }))
      // Extensions that have never shipped @extport/sdk/analytics, or
      // shipped it but haven't had a first rollup yet, would otherwise pad
      // the list with rows of zeros.
      .filter((e) => e.allTimeInstalls > 0)
      .sort((a, b) => b.weeklyActives - a.weeklyActives)

    return c.json({ extensions: items })
  },
)
