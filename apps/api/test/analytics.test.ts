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
    // departed i3.
    expect(find(day(-1), 'chrome', 'total', '')).toMatchObject({ dau: 2, installs: 1, mau: 2, departures: 0 })
    // Firefox had no pings yesterday but one install in the MAU window.
    expect(find(day(-1), 'firefox', 'total', '')).toMatchObject({ dau: 0, installs: 0, mau: 1 })
    // Departure confirmed today, written into the historical last-seen row.
    expect(find(day(-31), 'chrome', 'total', '')).toMatchObject({ departures: 1, dau: 0 })

    // Dimension rows carry dau only.
    expect(find(day(-1), 'chrome', 'version', '1.0.1')).toMatchObject({ dau: 2 })
    expect(find(day(-1), 'chrome', 'country', 'us')).toMatchObject({ dau: 1 })
    expect(find(day(-1), 'chrome', 'country', 'de')).toMatchObject({ dau: 1 })
    expect(find(day(-1), 'chrome', 'language', 'en-us')).toMatchObject({ dau: 1 })
    expect(find(day(-1), 'chrome', 'os', 'windows')).toMatchObject({ dau: 1 })

    // The 90-day prune removed the ancient raw row, kept yesterday's.
    const raw = await db.select().from(analyticsPings).where(eq(analyticsPings.extensionId, extension.id))
    expect(raw.map((r) => r.date).sort()).toEqual([day(-1), day(-1), day(-1)])
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
    ).json()) as { activeInstalls: number; allTimeInstalls: number; versions: { version: string; installs: number }[]; browsers: { browser: string; installs: number }[] }
    // i1, i2, i4 are active (30-day window); departed i3 is not.
    expect(overview.activeInstalls).toBe(3)
    expect(overview.allTimeInstalls).toBe(4)
    expect(overview.versions.find((v) => v.version === '1.0.1')).toMatchObject({ installs: 2 })
    expect(overview.browsers.find((b) => b.browser === 'firefox')).toMatchObject({ installs: 1 })

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
