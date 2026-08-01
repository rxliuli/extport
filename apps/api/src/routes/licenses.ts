import { newId } from '@extport/shared'
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { activations, extensions, licenseEvents, licenses, plans } from '../db'
import { uniqueLicenseKey } from '../lib/license-key'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireAuth, type AppEnv } from '../middleware/auth'

// Tenant-facing license management. Slice A covers manual issuance (the
// dogfood path); Stripe-webhook issuance lands in slice B with
// source: 'stripe_webhook' through this same table. See docs/licensing.md.
const route = new Hono<AppEnv>()

route.use('*', requireAuth, requireActiveTenant)

const PAGE_SIZE = 20

route.get(
  '/',
  describeRoute({
    summary: 'List licenses',
    description:
      'Newest first, 20 per page, each row carrying its plan tier and extension for cross-product views. Filter with ?plan=, ?extension=, or ?search= (case-insensitive substring of an activation code or buyer email); pass the previous response\'s nextCursor as ?cursor= to fetch the next page.',
    responses: { 200: { description: 'OK' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const planId = c.req.query('plan')
    const extensionId = c.req.query('extension')
    const cursor = c.req.query('cursor')
    const search = c.req.query('search')?.trim()

    const filters = [eq(licenses.tenantId, tenant.id)]
    if (planId) filters.push(eq(licenses.planId, planId))
    if (extensionId) filters.push(eq(plans.extensionId, extensionId))
    // Substring match over codes and buyer emails — support starts from a
    // fragment ("the gmail buyer", half a pasted code). SQLite's LIKE is
    // case-insensitive for ASCII on its own, and the tenant filter already
    // bounds the scan to this tenant's rows.
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
      filters.push(
        or(sql`${licenses.key} like ${pattern} escape '\\'`, sql`${licenses.buyerEmail} like ${pattern} escape '\\'`)!,
      )
    }
    // Keyset cursor "createdAt~id": strictly older rows, with the random id
    // as a stable tiebreak for rows created in the same millisecond.
    if (cursor) {
      const sep = cursor.lastIndexOf('~')
      if (sep === -1) return c.json({ error: 'cursor must be "createdAt~id"' }, 400)
      const createdAt = cursor.slice(0, sep)
      const id = cursor.slice(sep + 1)
      filters.push(
        or(lt(licenses.createdAt, createdAt), and(eq(licenses.createdAt, createdAt), lt(licenses.id, id)))!,
      )
    }

    const rows = await db
      .select({ license: licenses, tier: plans.tier, extensionId: plans.extensionId, extensionName: extensions.name })
      .from(licenses)
      .innerJoin(plans, eq(plans.id, licenses.planId))
      .innerJoin(extensions, eq(extensions.id, plans.extensionId))
      .where(and(...filters))
      .orderBy(desc(licenses.createdAt), desc(licenses.id))
      .limit(PAGE_SIZE + 1)

    const page = rows.slice(0, PAGE_SIZE).map((r) => ({ ...r.license, tier: r.tier, extensionId: r.extensionId, extensionName: r.extensionName }))
    const last = page[page.length - 1]
    const nextCursor = rows.length > PAGE_SIZE ? `${last!.createdAt}~${last!.id}` : null
    return c.json({ licenses: page, nextCursor })
  },
)

route.get(
  '/summary',
  describeRoute({
    summary: 'Tenant-wide licensing summary',
    description: 'License counts and revenue totals (smallest currency unit, grouped by currency) across every extension.',
    responses: { 200: { description: 'OK' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const [counts] = await db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`sum(case when ${licenses.status} = 'active' then 1 else 0 end)`,
      })
      .from(licenses)
      .where(eq(licenses.tenantId, tenant.id))

    const revenue = await db
      .select({
        currency: licenses.currency,
        total: sql<number>`coalesce(sum(${licenses.amountTotal}), 0)`,
        last30d: sql<number>`coalesce(sum(case when ${licenses.createdAt} >= ${thirtyDaysAgo} then ${licenses.amountTotal} else 0 end), 0)`,
      })
      .from(licenses)
      .where(and(eq(licenses.tenantId, tenant.id), sql`${licenses.currency} is not null`))
      .groupBy(licenses.currency)

    return c.json({ licenses: counts!.total, active: counts!.active ?? 0, revenue })
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

route.get(
  '/:id',
  describeRoute({ summary: 'Get a license with its activations', responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const [license] = await db
      .select()
      .from(licenses)
      .where(and(eq(licenses.tenantId, tenant.id), eq(licenses.id, c.req.param('id'))))
    if (!license) return c.json({ error: 'not found' }, 404)
    const [plan] = await db.select().from(plans).where(eq(plans.id, license.planId))
    const deviceRows = await db.select().from(activations).where(eq(activations.licenseId, license.id)).orderBy(activations.activatedAt)
    return c.json({ license, plan: plan ?? null, activations: deviceRows })
  },
)

const releaseBodySchema = v.object({
  fingerprint: v.pipe(v.string('fingerprint is required'), v.trim(), v.minLength(1, 'fingerprint is required')),
})

// The manual escape hatch the buyer portal deliberately lacks — buyers
// reach it through the tenant. Emits the 'reset' event.
route.post(
  '/:id/release',
  describeRoute({
    summary: "Release one of a license's seats",
    responses: { 200: { description: 'Released (idempotent)' }, 404: { description: 'License or device not found' } },
  }),
  validator('json', releaseBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const { fingerprint } = c.req.valid('json')
    const [license] = await db
      .select()
      .from(licenses)
      .where(and(eq(licenses.tenantId, tenant.id), eq(licenses.id, c.req.param('id'))))
    if (!license) return c.json({ error: 'not found' }, 404)

    const [activation] = await db
      .select()
      .from(activations)
      .where(and(eq(activations.licenseId, license.id), eq(activations.deviceFingerprint, fingerprint)))
    if (!activation) return c.json({ error: 'device not found' }, 404)
    if (activation.releasedAt) return c.json({ ok: true })

    await db.update(activations).set({ releasedAt: new Date().toISOString() }).where(eq(activations.id, activation.id))
    await db.insert(licenseEvents).values({
      id: newId('licenseEvent'),
      tenantId: tenant.id,
      licenseId: license.id,
      type: 'reset',
      payload: { fingerprint, by: 'tenant' },
    })
    return c.json({ ok: true })
  },
)

export default route
