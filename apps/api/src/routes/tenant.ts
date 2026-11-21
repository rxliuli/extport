import {
  DEFAULT_STALE_REVIEW_DAYS,
  isValidHttpUrl,
  isValidSupportUrl,
  STORES,
  type TenantSettings,
} from '@extport/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { tenants } from '../db'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireSession, type AppEnv } from '../middleware/auth'

const route = new Hono<AppEnv>()

// Tenant-wide settings (review-staleness thresholds) are dashboard-managed
// only — never exposed to API-key callers.
route.use('*', requireSession, requireActiveTenant)

const settingsResponseSchema = v.object({
  staleReviewDays: v.record(v.picklist(STORES), v.number()),
  supportUrl: v.nullable(v.string()),
  billingPortalUrl: v.nullable(v.string()),
})

function settingsResponse(settings: TenantSettings) {
  return {
    staleReviewDays: { ...DEFAULT_STALE_REVIEW_DAYS, ...settings.staleReviewDays },
    supportUrl: settings.supportUrl ?? null,
    billingPortalUrl: settings.billingPortalUrl ?? null,
  }
}

route.get(
  '/settings',
  describeRoute({
    summary: 'Get tenant settings',
    tags: ['Tenant'],
    security: [{ session: [] }],
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: resolver(settingsResponseSchema) } } },
    },
  }),
  (c) => c.json(settingsResponse(c.get('tenant').settings)),
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
  // null (or an empty string) clears it.
  supportUrl: v.optional(
    v.nullable(
      v.pipe(
        v.string(),
        v.trim(),
        v.check((s) => s === '' || isValidSupportUrl(s), 'supportUrl must be an http(s) URL or a mailto: address'),
      ),
    ),
  ),
  billingPortalUrl: v.optional(
    v.nullable(
      v.pipe(
        v.string(),
        v.trim(),
        v.check((s) => s === '' || isValidHttpUrl(s), 'billingPortalUrl must be an http(s) URL'),
      ),
    ),
  ),
})

route.patch(
  '/settings',
  describeRoute({
    summary: 'Update tenant settings',
    description:
      'Partially override tenant settings (per-store stale-review thresholds, buyer support URL, and Stripe Customer Portal link).',
    tags: ['Tenant'],
    security: [{ session: [] }],
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: resolver(settingsResponseSchema) } } },
    },
  }),
  validator('json', patchSettingsBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    const current = tenant.settings
    const next: TenantSettings = { ...current }
    if (body.staleReviewDays !== undefined) {
      next.staleReviewDays = { ...current.staleReviewDays, ...body.staleReviewDays }
    }
    if (body.supportUrl !== undefined) {
      if (body.supportUrl) next.supportUrl = body.supportUrl
      else delete next.supportUrl
    }
    if (body.billingPortalUrl !== undefined) {
      if (body.billingPortalUrl) next.billingPortalUrl = body.billingPortalUrl
      else delete next.billingPortalUrl
    }

    await db.update(tenants).set({ settings: next }).where(eq(tenants.id, tenant.id))
    return c.json(settingsResponse(next))
  },
)

export default route
