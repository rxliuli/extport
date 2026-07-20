import { DEFAULT_STALE_REVIEW_DAYS, STORES, type Store, type TenantSettings } from '@extport/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { tenants } from '../db'
import { requireSession, type AppEnv } from '../middleware/auth'
import { parseTenantSettings } from '../lib/tenant-settings'

const route = new Hono<AppEnv>()

// Tenant-wide settings (auto_withdraw, review-staleness thresholds) are
// dashboard-managed only — never exposed to API-key callers.
route.use('*', requireSession)

route.get('/settings', (c) => {
  const settings = parseTenantSettings(c.get('tenant').settingsJson)
  return c.json({
    autoWithdraw: settings.autoWithdraw ?? true,
    staleReviewDays: { ...DEFAULT_STALE_REVIEW_DAYS, ...settings.staleReviewDays },
  })
})

route.patch('/settings', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const body = await c.req
    .json<{ autoWithdraw?: boolean; staleReviewDays?: Partial<Record<Store, number>> }>()
    .catch(() => ({}) as Record<string, never>)

  const current = parseTenantSettings(tenant.settingsJson)
  const next: TenantSettings = { ...current }

  if (typeof body.autoWithdraw === 'boolean') next.autoWithdraw = body.autoWithdraw

  if (body.staleReviewDays !== undefined) {
    if (typeof body.staleReviewDays !== 'object' || body.staleReviewDays === null) {
      return c.json({ error: 'staleReviewDays must be an object keyed by store' }, 400)
    }
    const merged: Partial<Record<Store, number>> = { ...current.staleReviewDays }
    for (const [store, days] of Object.entries(body.staleReviewDays)) {
      if (!(STORES as readonly string[]).includes(store)) {
        return c.json({ error: `unknown store "${store}" in staleReviewDays` }, 400)
      }
      if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
        return c.json({ error: `staleReviewDays.${store} must be a positive number` }, 400)
      }
      merged[store as Store] = days
    }
    next.staleReviewDays = merged
  }

  await db.update(tenants).set({ settingsJson: JSON.stringify(next) }).where(eq(tenants.id, tenant.id))
  return c.json({
    autoWithdraw: next.autoWithdraw ?? true,
    staleReviewDays: { ...DEFAULT_STALE_REVIEW_DAYS, ...next.staleReviewDays },
  })
})

export default route
