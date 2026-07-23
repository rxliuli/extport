import { DEFAULT_STALE_REVIEW_DAYS, STORES, type TenantSettings } from '@extport/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { tenants } from '../db'
import { parseTenantSettings } from '../lib/tenant-settings'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireSession, type AppEnv } from '../middleware/auth'

const route = new Hono<AppEnv>()

// Tenant-wide settings (review-staleness thresholds) are dashboard-managed
// only — never exposed to API-key callers.
route.use('*', requireSession, requireActiveTenant)

const settingsResponseSchema = v.object({ staleReviewDays: v.record(v.picklist(STORES), v.number()) })

route.get(
  '/settings',
  describeRoute({
    summary: 'Get tenant settings',
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: resolver(settingsResponseSchema) } } } },
  }),
  (c) => {
    const settings = parseTenantSettings(c.get('tenant').settingsJson)
    return c.json({
      staleReviewDays: { ...DEFAULT_STALE_REVIEW_DAYS, ...settings.staleReviewDays },
    })
  },
)

const patchSettingsBodySchema = v.object({
  staleReviewDays: v.optional(
    v.record(
      v.picklist(STORES, 'unknown store in staleReviewDays'),
      v.pipe(
        v.number('staleReviewDays value must be a positive number'),
        v.finite('staleReviewDays value must be a positive number'),
        v.check((n) => n > 0, 'staleReviewDays value must be a positive number'),
      ),
    ),
  ),
})

route.patch(
  '/settings',
  describeRoute({
    summary: 'Update tenant settings',
    description: 'Partially override the per-store stale-review thresholds (days a version can sit "in review" before it is flagged).',
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: resolver(settingsResponseSchema) } } } },
  }),
  validator('json', patchSettingsBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    const current = parseTenantSettings(tenant.settingsJson)
    const next: TenantSettings = { ...current }
    if (body.staleReviewDays !== undefined) {
      next.staleReviewDays = { ...current.staleReviewDays, ...body.staleReviewDays }
    }

    await db.update(tenants).set({ settingsJson: JSON.stringify(next) }).where(eq(tenants.id, tenant.id))
    return c.json({
      staleReviewDays: { ...DEFAULT_STALE_REVIEW_DAYS, ...next.staleReviewDays },
    })
  },
)

export default route
