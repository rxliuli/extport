import { newId } from '@extport/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { extensions, plans } from '../db'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireAuth, type AppEnv } from '../middleware/auth'

// Licensing plan catalog: one row per (extension, tier) — a plan has no
// name of its own, the extension (ext_… id) is its identity.
// See docs/licensing.md.
const route = new Hono<AppEnv>()

route.use('*', requireAuth, requireActiveTenant)

route.get(
  '/',
  describeRoute({ summary: 'List plans', responses: { 200: { description: 'OK' } }, tags: ['Licensing'] }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const extensionId = c.req.query('extension')
    const rows = await db
      .select()
      .from(plans)
      .where(
        extensionId
          ? and(eq(plans.tenantId, tenant.id), eq(plans.extensionId, extensionId))
          : eq(plans.tenantId, tenant.id),
      )
      .orderBy(plans.createdAt)
    return c.json({ plans: rows })
  },
)

const createProductBodySchema = v.object({
  extensionId: v.pipe(v.string('extensionId is required'), v.trim(), v.minLength(1, 'extensionId is required')),
  tier: v.pipe(v.string('tier is required'), v.trim(), v.minLength(1, 'tier is required'), v.maxLength(32)),
  maxActivations: v.optional(v.pipe(v.number('maxActivations must be a number'), v.integer('maxActivations must be an integer'), v.minValue(1, 'maxActivations must be at least 1'), v.maxValue(100, 'maxActivations must be at most 100'))),
})

route.post(
  '/',
  describeRoute({
    tags: ['Licensing'],
    summary: 'Create a plan',
    description: "One plan per (extension, tier) — a plan has no name of its own.",
    responses: { 201: { description: 'Created' }, 404: { description: 'Extension not found' }, 409: { description: 'Tier already exists for this extension' } },
  }),
  validator('json', createProductBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    // The SDK resolves unknown tiers to 'free' — a paid plan named
    // 'free' could never activate anything.
    if (body.tier === 'free') return c.json({ error: 'tier "free" is reserved for the unpaid tier' }, 400)

    const [extension] = await db
      .select({ id: extensions.id })
      .from(extensions)
      .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, body.extensionId)))
    if (!extension) return c.json({ error: 'extension not found' }, 404)

    const [conflict] = await db
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.extensionId, extension.id), eq(plans.tier, body.tier)))
    if (conflict) return c.json({ error: `tier "${body.tier}" already exists for this extension` }, 409)

    const id = newId('plan')
    await db.insert(plans).values({
      id,
      tenantId: tenant.id,
      extensionId: extension.id,
      tier: body.tier,
      maxActivations: body.maxActivations ?? 3,
    })
    const [created] = await db.select().from(plans).where(eq(plans.id, id))
    return c.json({ plan: created }, 201)
  },
)

const patchPlanBodySchema = v.object({
  maxActivations: v.pipe(v.number('maxActivations must be a number'), v.integer('maxActivations must be an integer'), v.minValue(1, 'maxActivations must be at least 1'), v.maxValue(100, 'maxActivations must be at most 100')),
})

// Deliberately only maxActivations (snapshot semantics — affects future
// issuance only). `tier` is burned into installed extension binaries as
// the SDK's tier table; editing it would fail existing devices' checks.
// Sell a different tier? Create a new plan.
route.patch(
  '/:id',
  describeRoute({
    tags: ['Licensing'],
    summary: "Update a plan's device limit",
    description: 'Only maxActivations is editable — tier is a wire contract baked into shipped extensions.',
    responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } },
  }),
  validator('json', patchPlanBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')
    const result = await db
      .update(plans)
      .set({ maxActivations: body.maxActivations })
      .where(and(eq(plans.tenantId, tenant.id), eq(plans.id, c.req.param('id'))))
    if (result.meta.changes === 0) return c.json({ error: 'not found' }, 404)
    const [updated] = await db.select().from(plans).where(eq(plans.id, c.req.param('id')))
    return c.json({ plan: updated })
  },
)

export default route
