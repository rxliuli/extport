import { newId } from '@extport/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { analyticsDaily, analyticsInstalls, analyticsPings, extensions } from '../db'
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
    const browser = parseBrowser(ua)

    // Server-side idempotency gate: the SDK already dedups per UTC day, but
    // a misbehaving client must not be able to inflate anything.
    const [install] = await db
      .select()
      .from(analyticsInstalls)
      .where(and(eq(analyticsInstalls.extensionId, extension.id), eq(analyticsInstalls.installId, body.installId)))
    if (install?.lastSeen === today) return c.body(null, 204)

    const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf
    // One batch = one D1 transaction. The client is an extension background
    // that may be torn down mid-request (and Workers can be cancelled with
    // it) — the install row and its ping must land together or not at all,
    // or aborts leave phantom installs that never pinged.
    await db.batch([
      db
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
        // Two same-day pings racing past the gate resolve here; the raw
        // duplicate they leave behind is neutralized by the rollup's
        // count(distinct install_id).
        .onConflictDoUpdate({
          target: [analyticsInstalls.extensionId, analyticsInstalls.installId],
          set: { lastSeen: today, lastVersion: body.version },
        }),
      db.insert(analyticsPings).values({
        id: newId('analyticsPing'),
        tenantId: extension.tenantId,
        extensionId: extension.id,
        installId: body.installId,
        date: today,
        browser,
        version: body.version,
        os: parseOs(ua),
        country: cf?.country?.toLowerCase() ?? null,
        language: body.language?.toLowerCase() || null,
      }),
    ])

    return c.body(null, 204)
  },
)

// ---- Tenant read endpoints (dashboard charts) ----

export const analyticsTenantRoutes = new Hono<AppEnv>()
analyticsTenantRoutes.use('*', requireAuth, requireActiveTenant)

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
      "Rows from the permanent rollup for one extension: ?dim=total (headline dau/mau/installs/departures) or version/country/language/os (dau only). ?days= bounds the window (default 90, max 1830). Departures live on the last-seen day and are only present once confirmed — the trailing 30 days legitimately show none.",
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
    return c.json({ rows })
  },
)

analyticsTenantRoutes.get(
  '/overview',
  describeRoute({
    summary: 'Live analytics overview',
    description:
      'Exact numbers straight from install state (not the rollup): active installs (seen in 30 days), and the current version distribution among them — the saturation gate for sales flips.',
    responses: { 200: { description: 'OK' }, 404: { description: 'Extension not found' } },
  }),
  async (c) => {
    const db = c.get('db')
    const extension = await ownedExtension(c)
    if (!extension) return c.json({ error: 'extension not found' }, 404)

    const windowStart = isoDay(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000))
    const active = and(eq(analyticsInstalls.extensionId, extension.id), gte(analyticsInstalls.lastSeen, windowStart))

    const [totals] = await db
      .select({ activeInstalls: sql<number>`count(*)`, allTime: sql<number>`(select count(*) from analytics_installs where extension_id = ${extension.id})` })
      .from(analyticsInstalls)
      .where(active)
    const versions = await db
      .select({ version: analyticsInstalls.lastVersion, installs: sql<number>`count(*)` })
      .from(analyticsInstalls)
      .where(active)
      .groupBy(analyticsInstalls.lastVersion)
      .orderBy(sql`count(*) desc`)
    const browsers = await db
      .select({ browser: analyticsInstalls.browser, installs: sql<number>`count(*)` })
      .from(analyticsInstalls)
      .where(active)
      .groupBy(analyticsInstalls.browser)

    return c.json({ activeInstalls: totals?.activeInstalls ?? 0, allTimeInstalls: totals?.allTime ?? 0, versions, browsers })
  },
)
