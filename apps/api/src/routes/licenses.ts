import { newId } from '@extport/shared'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { licenseEvents, licenses, plans } from '../db'
import { uniqueLicenseKey } from '../lib/license-key'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireAuth, type AppEnv } from '../middleware/auth'

// Tenant-facing license management. Slice A covers manual issuance (the
// dogfood path); Stripe-webhook issuance lands in slice B with
// source: 'stripe_webhook' through this same table. See docs/licensing.md.
const route = new Hono<AppEnv>()

route.use('*', requireAuth, requireActiveTenant)

route.get(
  '/',
  describeRoute({ summary: 'List licenses', responses: { 200: { description: 'OK' } } }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const planId = c.req.query('plan')
    const rows = await db
      .select()
      .from(licenses)
      .where(
        planId
          ? and(eq(licenses.tenantId, tenant.id), eq(licenses.planId, planId))
          : eq(licenses.tenantId, tenant.id),
      )
      .orderBy(desc(licenses.createdAt))
    return c.json({ licenses: rows })
  },
)

const issueLicenseBodySchema = v.object({
  planId: v.pipe(v.string('planId is required'), v.trim(), v.minLength(1, 'planId is required')),
  buyerEmail: v.pipe(v.string('buyerEmail is required'), v.trim(), v.email('buyerEmail must be a valid email')),
})

route.post(
  '/',
  describeRoute({
    summary: 'Issue a license',
    description: 'Manually issues an activation code for a plan. The response is the only place the key is shown in full.',
    responses: { 201: { description: 'Issued' }, 404: { description: 'Plan not found' } },
  }),
  validator('json', issueLicenseBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    const [plan] = await db
      .select()
      .from(plans)
      .where(and(eq(plans.tenantId, tenant.id), eq(plans.id, body.planId)))
    if (!plan) return c.json({ error: 'plan not found' }, 404)

    const key = await uniqueLicenseKey(db)

    const id = newId('license')
    await db.insert(licenses).values({
      id,
      tenantId: tenant.id,
      planId: plan.id,
      key,
      buyerEmail: body.buyerEmail,
      entitlementType: plan.entitlementType,
      // Snapshot: later plan edits must not retroactively change
      // already-issued licenses.
      maxActivations: plan.maxActivations,
      source: 'manual',
    })
    await db.insert(licenseEvents).values({
      id: newId('licenseEvent'),
      tenantId: tenant.id,
      licenseId: id,
      type: 'issued',
      payload: { source: 'manual', planId: plan.id },
    })

    const [created] = await db.select().from(licenses).where(eq(licenses.id, id))
    return c.json({ license: created }, 201)
  },
)

export default route
