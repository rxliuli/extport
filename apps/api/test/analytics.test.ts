import { newId } from '@extport/shared'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { runAnalyticsRollup } from '../src/analytics/rollup'
import { analyticsDaily, analyticsInstalls, analyticsPings } from '../src/db'
import { addDays, isoDay } from '../src/lib/dates'
import { createExtension, request, seedTenantWithUser } from './helpers'

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0'

function ping(body: Record<string, unknown>, ua = CHROME_UA): Promise<Response> {
  return request('/api/v1/analytics/ping', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ua },
    body: JSON.stringify(body),
  })
}

async function setup() {
  const seeded = await seedTenantWithUser()
  const extension = await createExtension(seeded.sessionCookie)
  return { ...seeded, extension }
}

describe('POST /v1/analytics/ping', () => {
  it('records the install state and a raw ping with derived dimensions', async () => {
    const { db, extension } = await setup()
    const res = await ping({
      installId: 'aaaaaaaa-1111-2222-3333-444444444444',
      extensionId: extension.id,
      version: '1.2.3',
      language: 'en-US',
    })
    expect(res.status).toBe(204)

    const today = isoDay(new Date())
    const [install] = await db
      .select()
      .from(analyticsInstalls)
      .where(eq(analyticsInstalls.extensionId, extension.id))
    expect(install).toMatchObject({
      firstSeen: today,
      lastSeen: today,
      lastVersion: '1.2.3',
      browser: 'chrome',
    })

    const [raw] = await db.select().from(analyticsPings).where(eq(analyticsPings.extensionId, extension.id))
    expect(raw).toMatchObject({ date: today, browser: 'chrome', os: 'macos', version: '1.2.3', language: 'en-us' })
  })

  it('counts at most one ping per install per day, but a stale install re-pings fine', async () => {
    const { db, extension } = await setup()
    const installId = 'bbbbbbbb-1111-2222-3333-444444444444'
    await ping({ installId, extensionId: extension.id, version: '1.0.0' })
    const second = await ping({ installId, extensionId: extension.id, version: '1.0.0' })
    expect(second.status).toBe(204)
    expect(await db.select().from(analyticsPings).where(eq(analyticsPings.installId, installId))).toHaveLength(1)

    // A day later (simulated by backdating), the same install pings with a
    // newer version — the update inference is last_version moving.
    const yesterday = isoDay(addDays(new Date(), -1))
    await db
      .update(analyticsInstalls)
      .set({ lastSeen: yesterday })
      .where(and(eq(analyticsInstalls.extensionId, extension.id), eq(analyticsInstalls.installId, installId)))
    await ping({ installId, extensionId: extension.id, version: '1.0.1' }, FIREFOX_UA)

    expect(await db.select().from(analyticsPings).where(eq(analyticsPings.installId, installId))).toHaveLength(2)
    const [install] = await db
      .select()
      .from(analyticsInstalls)
      .where(and(eq(analyticsInstalls.extensionId, extension.id), eq(analyticsInstalls.installId, installId)))
    expect(install!.lastSeen).toBe(isoDay(new Date()))
    expect(install!.lastVersion).toBe('1.0.1')
    // Install-row browser is fixed at first seen; the raw ping records the
    // UA it actually came from.
    expect(install!.browser).toBe('chrome')
  })

  it('silently drops headless-browser pings — CI e2e must not mint installs', async () => {
    const { db, extension } = await setup()
    const res = await ping(
      { installId: 'dddddddd-1111-2222-3333-444444444444', extensionId: extension.id, version: '1.0.0' },
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36',
    )
    expect(res.status).toBe(204)
    expect(await db.select().from(analyticsInstalls).where(eq(analyticsInstalls.extensionId, extension.id))).toHaveLength(0)
  })

  it('silently drops UA-less pings — curl tests must not mint installs either', async () => {
    const { db, extension } = await setup()
    const res = await request('/api/v1/analytics/ping', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installId: 'eeeeeeee-1111-2222-3333-444444444444', extensionId: extension.id, version: '1.0.0' }),
    })
    expect(res.status).toBe(204)
    expect(await db.select().from(analyticsInstalls).where(eq(analyticsInstalls.extensionId, extension.id))).toHaveLength(0)
  })

  it('answers 204 for unknown extensions without writing anything, 400 for bad bodies, and is CORS-open', async () => {
    const { db } = await setup()
    const unknown = await ping({ installId: 'cccccccc-1111-2222-3333-444444444444', extensionId: 'ext_nope', version: '1' })
    expect(unknown.status).toBe(204)
    expect(await db.select().from(analyticsPings).where(eq(analyticsPings.extensionId, 'ext_nope'))).toHaveLength(0)

    const bad = await ping({ installId: 'short', extensionId: 'ext_nope', version: '1' })
    expect(bad.status).toBe(400)

    const preflight = await request('/api/v1/analytics/ping', {
      method: 'OPTIONS',
      headers: { origin: 'chrome-extension://abc', 'access-control-request-method': 'POST' },
    })
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('analytics rollup', () => {
  async function seedScenario() {
    const { db, extension, sessionCookie } = await setup()
    const now = new Date()
    const day = (offset: number) => isoDay(addDays(now, offset))
    const base = { tenantId: 'ignored', extensionId: extension.id }

    const installRows = [
      // New install yesterday, pinged yesterday.
      { installId: 'i1', browser: 'chrome', firstSeen: day(-1), lastSeen: day(-1), lastVersion: '1.0.1' },
      // Long-standing install, active yesterday.
      { installId: 'i2', browser: 'chrome', firstSeen: day(-29), lastSeen: day(-1), lastVersion: '1.0.1' },
      // Departed: last seen exactly 31 days ago — confirmed today.
      { installId: 'i3', browser: 'chrome', firstSeen: day(-60), lastSeen: day(-31), lastVersion: '1.0.0' },
      // In the MAU window but quiet yesterday.
      { installId: 'i4', browser: 'firefox', firstSeen: day(-10), lastSeen: day(-5), lastVersion: '1.0.0' },
    ]
    for (const row of installRows) {
      await db.insert(analyticsInstalls).values({ ...base, tenantId: extension.id, ...row })
    }

    const rawRows = [
      { installId: 'i1', date: day(-1), browser: 'chrome', version: '1.0.1', country: 'us', language: 'en-us', os: 'macos' },
      // Duplicate raced row for i1 — must not inflate dau.
      { installId: 'i1', date: day(-1), browser: 'chrome', version: '1.0.1', country: 'us', language: 'en-us', os: 'macos' },
      { installId: 'i2', date: day(-1), browser: 'chrome', version: '1.0.1', country: 'de', language: 'de', os: 'windows' },
      // i4's only ping this week — inside the 7-day WAU window but not
      // yesterday, so it counts for wau and not dau.
      { installId: 'i4', date: day(-5), browser: 'firefox', version: '1.0.0', country: 'fr', language: 'fr', os: 'linux' },
      // Ancient ping past the 90-day window — pruned by the rollup.
      { installId: 'i3', date: day(-120), browser: 'chrome', version: '1.0.0', country: null, language: null, os: null },
    ]
    for (const row of rawRows) {
      await db.insert(analyticsPings).values({ id: newId('analyticsPing'), tenantId: extension.id, extensionId: extension.id, ...row })
    }
    return { db, extension, sessionCookie, now, day }
  }

  it('computes headline + dimension rows, attributes departures to the last-seen day, and prunes', async () => {
    const { db, extension, now, day } = await seedScenario()
    await runAnalyticsRollup(db, now)

    const rows = await db.select().from(analyticsDaily).where(eq(analyticsDaily.extensionId, extension.id))
    const find = (date: string, browser: string, dim: string, dimValue: string) =>
      rows.find((r) => r.date === date && r.browser === browser && r.dim === dim && r.dimValue === dimValue)

    // Headline, chrome: dau counts distinct installs (raced duplicate
    // ignored), installs from first_seen, MAU covers i1+i2 but not the
    // departed i3. WAU equals dau here — both actives pinged yesterday.
    expect(find(day(-1), 'chrome', 'total', '')).toMatchObject({ dau: 2, wau: 2, installs: 1, mau: 2, departures: 0 })
    // Firefox had no pings yesterday but pinged within the week — exactly
    // the running-but-idle install WAU exists to keep counting.
    expect(find(day(-1), 'firefox', 'total', '')).toMatchObject({ dau: 0, wau: 1, installs: 0, mau: 1 })
    // Departure confirmed today, written into the historical last-seen row.
    expect(find(day(-31), 'chrome', 'total', '')).toMatchObject({ departures: 1, dau: 0 })

    // Dimension rows carry dau + wau.
    expect(find(day(-1), 'chrome', 'version', '1.0.1')).toMatchObject({ dau: 2, wau: 2 })
    expect(find(day(-1), 'chrome', 'country', 'us')).toMatchObject({ dau: 1, wau: 1 })
    expect(find(day(-1), 'chrome', 'country', 'de')).toMatchObject({ dau: 1, wau: 1 })
    expect(find(day(-1), 'chrome', 'language', 'en-us')).toMatchObject({ dau: 1, wau: 1 })
    expect(find(day(-1), 'chrome', 'os', 'windows')).toMatchObject({ dau: 1, wau: 1 })
    // i4's country pinged this week but not yesterday — the dimension row
    // exists on yesterday's date purely for its wau, dau legitimately 0.
    expect(find(day(-1), 'firefox', 'country', 'fr')).toMatchObject({ dau: 0, wau: 1 })
    expect(find(day(-1), 'firefox', 'os', 'linux')).toMatchObject({ dau: 0, wau: 1 })

    // The 90-day prune removed the ancient raw row, kept this week's.
    const raw = await db.select().from(analyticsPings).where(eq(analyticsPings.extensionId, extension.id))
    expect(raw.map((r) => r.date).sort()).toEqual([day(-5), day(-1), day(-1), day(-1)])
  })

  it('is idempotent — re-running produces identical rows', async () => {
    const { db, extension, now } = await seedScenario()
    await runAnalyticsRollup(db, now)
    const first = await db.select().from(analyticsDaily).where(eq(analyticsDaily.extensionId, extension.id))
    await runAnalyticsRollup(db, now)
    const second = await db.select().from(analyticsDaily).where(eq(analyticsDaily.extensionId, extension.id))
    expect(second).toEqual(first)
  })

  it('serves series and overview to the owning tenant only', async () => {
    const { db, extension, sessionCookie, now, day } = await seedScenario()
    await runAnalyticsRollup(db, now)

    const series = (await (
      await request(`/api/v1/analytics/series?extension=${extension.id}&dim=total`, {
        headers: { cookie: sessionCookie },
      })
    ).json()) as { rows: { date: string; browser: string; dau: number; departures: number }[] }
    expect(series.rows.find((r) => r.date === day(-1) && r.browser === 'chrome')).toMatchObject({ dau: 2 })
    expect(series.rows.find((r) => r.date === day(-31) && r.browser === 'chrome')).toMatchObject({ departures: 1 })

    const versions = (await (
      await request(`/api/v1/analytics/series?extension=${extension.id}&dim=version`, {
        headers: { cookie: sessionCookie },
      })
    ).json()) as { rows: { dimValue: string; dau: number }[] }
    expect(versions.rows.find((r) => r.dimValue === '1.0.1')).toMatchObject({ dau: 2 })

    const overview = (await (
      await request(`/api/v1/analytics/overview?extension=${extension.id}`, { headers: { cookie: sessionCookie } })
    ).json()) as { activeInstalls: number; allTimeInstalls: number; versions: { version: string; installs: number }[] }
    // Derived from analytics_daily (the rollup), not live install state —
    // see the "fleet-wide analytics" describe block below for the case
    // that actually motivated the switch. activeInstalls sums mau (chrome
    // 2 + firefox 1) on the one rolled-up day this test produces;
    // allTimeInstalls sums installs on that same single day (only i1's
    // first_seen falls on it — a single runAnalyticsRollup() call only
    // ever processes "yesterday", so i2/i3/i4's first_seen dates were
    // never rolled up here, unlike a real fleet with many nights behind it).
    expect(overview.activeInstalls).toBe(3)
    expect(overview.allTimeInstalls).toBe(1)
    expect(overview.versions.find((v) => v.version === '1.0.1')).toMatchObject({ installs: 2 })

    // Auth + scoping.
    expect((await request(`/api/v1/analytics/series?extension=${extension.id}`)).status).toBe(401)
    const stranger = await seedTenantWithUser()
    expect(
      (
        await request(`/api/v1/analytics/series?extension=${extension.id}`, {
          headers: { cookie: stranger.sessionCookie },
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await request(`/api/v1/analytics/series?extension=${extension.id}&dim=bogus`, {
          headers: { cookie: sessionCookie },
        })
      ).status,
    ).toBe(400)
  })
})

describe('fleet-wide analytics', () => {
  it('sums totals across every extension, ranks them as a per-extension list, and stays tenant-scoped', async () => {
    const { db, tenantId, sessionCookie } = await seedTenantWithUser()
    const extA = await createExtension(sessionCookie, 'Extension A')
    const extB = await createExtension(sessionCookie, 'Extension B')
    const now = new Date()
    const day = (offset: number) => isoDay(addDays(now, offset))

    // Both extensions rolled up through the same latest day here — the
    // "extension rolled up on a different day than the rest of the fleet"
    // case gets its own test below.
    await db.insert(analyticsDaily).values([
      { tenantId, extensionId: extA.id, date: day(-2), browser: 'chrome', dim: 'total', dimValue: '', dau: 1, installs: 1, departures: 0, mau: 1 },
      { tenantId, extensionId: extA.id, date: day(-1), browser: 'chrome', dim: 'total', dimValue: '', dau: 2, installs: 0, departures: 0, mau: 2 },
      { tenantId, extensionId: extA.id, date: day(-1), browser: 'firefox', dim: 'total', dimValue: '', dau: 1, installs: 1, departures: 0, mau: 1 },
      { tenantId, extensionId: extB.id, date: day(-1), browser: 'chrome', dim: 'total', dimValue: '', dau: 5, installs: 1, departures: 0, mau: 5 },
    ])

    const overview = (await (
      await request('/api/v1/analytics/fleet/overview', { headers: { cookie: sessionCookie } })
    ).json()) as { activeInstalls: number; allTimeInstalls: number; extensionsReporting: number }
    // activeInstalls: only day(-1) (the latest date) counts — A's chrome
    // mau(2) + firefox mau(1) + B's chrome mau(5) = 8, ignoring A's day(-2)
    // row entirely. allTimeInstalls: installs summed across every date —
    // 1 (day(-2)) + 0 + 1 + 1 = 3.
    expect(overview).toMatchObject({ activeInstalls: 8, allTimeInstalls: 3, extensionsReporting: 2 })

    const series = (await (
      await request('/api/v1/analytics/fleet/series', { headers: { cookie: sessionCookie } })
    ).json()) as { rows: { date: string; browser: string; dau: number; installs: number; mau: number }[] }
    // Both extensions' chrome rows for the same day sum into one row.
    expect(series.rows.find((r) => r.date === day(-1) && r.browser === 'chrome')).toMatchObject({ dau: 7, installs: 1, mau: 7 })

    const list = (await (
      await request('/api/v1/analytics/fleet/extensions', { headers: { cookie: sessionCookie } })
    ).json()) as { extensions: { extensionId: string; name: string; activeInstalls: number; allTimeInstalls: number }[] }
    // Ranked by active installs, not alphabetically or by creation order —
    // B(5) ahead of A(3, split chrome+firefox) despite A being created first.
    expect(list.extensions).toEqual([
      { extensionId: extB.id, name: 'Extension B', activeInstalls: 5, allTimeInstalls: 1 },
      { extensionId: extA.id, name: 'Extension A', activeInstalls: 3, allTimeInstalls: 2 },
    ])

    // Auth + tenant scoping — a stranger tenant sees none of this.
    expect((await request('/api/v1/analytics/fleet/overview')).status).toBe(401)
    const stranger = await seedTenantWithUser()
    const strangerOverview = (await (
      await request('/api/v1/analytics/fleet/overview', { headers: { cookie: stranger.sessionCookie } })
    ).json()) as { activeInstalls: number; extensionsReporting: number }
    expect(strangerOverview).toMatchObject({ activeInstalls: 0, extensionsReporting: 0 })
    const strangerList = (await (
      await request('/api/v1/analytics/fleet/extensions', { headers: { cookie: stranger.sessionCookie } })
    ).json()) as { extensions: unknown[] }
    expect(strangerList.extensions).toEqual([])
  })

  it("uses each extension's own latest rolled-up day, not a shared fleet-wide one", async () => {
    // Reproduces a real incident: a newly-onboarded extension can have
    // hundreds of live installs but zero rollup rows on the same day the
    // rest of the fleet already has one, if it only started reporting
    // after last night's rollup ran. Its /fleet/extensions row must not
    // silently read as 0 just because most of the fleet is a day ahead.
    const { db, tenantId, sessionCookie } = await seedTenantWithUser()
    const stale = await createExtension(sessionCookie, 'Stale Extension')
    const fresh = await createExtension(sessionCookie, 'Fresh Extension')
    const now = new Date()
    const day = (offset: number) => isoDay(addDays(now, offset))

    await db.insert(analyticsDaily).values([
      // Only ever rolled up once, several days ago.
      { tenantId, extensionId: stale.id, date: day(-5), browser: 'chrome', dim: 'total', dimValue: '', dau: 4, installs: 4, departures: 0, mau: 4 },
      // Rolled up as recently as yesterday.
      { tenantId, extensionId: fresh.id, date: day(-1), browser: 'chrome', dim: 'total', dimValue: '', dau: 2, installs: 2, departures: 0, mau: 2 },
    ])

    const list = (await (
      await request('/api/v1/analytics/fleet/extensions', { headers: { cookie: sessionCookie } })
    ).json()) as { extensions: { extensionId: string; activeInstalls: number; allTimeInstalls: number }[] }
    expect(list.extensions).toEqual([
      { extensionId: stale.id, name: 'Stale Extension', activeInstalls: 4, allTimeInstalls: 4 },
      { extensionId: fresh.id, name: 'Fresh Extension', activeInstalls: 2, allTimeInstalls: 2 },
    ])
  })

  it('omits extensions that have never reported any analytics', async () => {
    const { sessionCookie } = await setup()
    const list = (await (
      await request('/api/v1/analytics/fleet/extensions', { headers: { cookie: sessionCookie } })
    ).json()) as { extensions: unknown[] }
    expect(list.extensions).toEqual([])
  })
})
