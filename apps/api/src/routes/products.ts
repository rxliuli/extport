import { newId } from '@extport/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { extensions, products } from '../db'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireAuth, type AppEnv } from '../middleware/auth'

// Licensing product catalog: one row per (extension, tier). `name` is the
// app-level name shared across tiers — it's what the SDK sends as
// productName. See docs/licensing.md.
const route = new Hono<AppEnv>()

route.use('*', requireAuth, requireActiveTenant)

route.get(
  '/',
  describeRoute({ summary: 'List products', responses: { 200: { description: 'OK' } } }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const extensionId = c.req.query('extension')
    const rows = await db
      .select()
      .from(products)
      .where(
        extensionId
          ? and(eq(products.tenantId, tenant.id), eq(products.extensionId, extensionId))
          : eq(products.tenantId, tenant.id),
      )
      .orderBy(products.createdAt)
    return c.json({ products: rows })
  },
)

const createProductBodySchema = v.object({
  extensionId: v.pipe(v.string('extensionId is required'), v.trim(), v.minLength(1, 'extensionId is required')),
  name: v.pipe(v.string('name is required'), v.trim(), v.minLength(1, 'name is required'), v.maxLength(200)),
  tier: v.pipe(v.string('tier is required'), v.trim(), v.minLength(1, 'tier is required'), v.maxLength(32)),
  maxActivations: v.optional(v.pipe(v.number('maxActivations must be a number'), v.integer('maxActivations must be an integer'), v.minValue(1, 'maxActivations must be at least 1'), v.maxValue(100, 'maxActivations must be at most 100'))),
})

route.post(
  '/',
  describeRoute({
    summary: 'Create a product',
    description: 'One product per (extension, tier). name is the app-level name the SDK sends as productName, shared across tiers.',
    responses: { 201: { description: 'Created' }, 404: { description: 'Extension not found' }, 409: { description: 'Tier already exists for this extension' } },
  }),
  validator('json', createProductBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    // The SDK resolves unknown tiers to 'free' — a paid product named
    // 'free' could never activate anything.
    if (body.tier === 'free') return c.json({ error: 'tier "free" is reserved for the unpaid tier' }, 400)

    const [extension] = await db
      .select({ id: extensions.id })
      .from(extensions)
      .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, body.extensionId)))
    if (!extension) return c.json({ error: 'extension not found' }, 404)

    const [conflict] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.extensionId, extension.id), eq(products.tier, body.tier)))
    if (conflict) return c.json({ error: `tier "${body.tier}" already exists for this extension` }, 409)

    const id = newId('product')
    await db.insert(products).values({
      id,
      tenantId: tenant.id,
      extensionId: extension.id,
      name: body.name,
      tier: body.tier,
      maxActivations: body.maxActivations ?? 3,
    })
    const [created] = await db.select().from(products).where(eq(products.id, id))
    return c.json({ product: created }, 201)
  },
)

export default route
