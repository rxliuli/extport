import { newId } from '@extport/shared'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { licenseEvents, licenses, products } from '../db'
import { generateLicenseKey } from '../lib/license-key'
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
    const productId = c.req.query('product')
    const rows = await db
      .select()
      .from(licenses)
      .where(
        productId
          ? and(eq(licenses.tenantId, tenant.id), eq(licenses.productId, productId))
          : eq(licenses.tenantId, tenant.id),
      )
      .orderBy(desc(licenses.createdAt))
    return c.json({ licenses: rows })
  },
)

const issueLicenseBodySchema = v.object({
  productId: v.pipe(v.string('productId is required'), v.trim(), v.minLength(1, 'productId is required')),
  buyerEmail: v.pipe(v.string('buyerEmail is required'), v.trim(), v.email('buyerEmail must be a valid email')),
})

route.post(
  '/',
  describeRoute({
    summary: 'Issue a license',
    description: 'Manually issues an activation code for a product. The response is the only place the key is shown in full.',
    responses: { 201: { description: 'Issued' }, 404: { description: 'Product not found' } },
  }),
  validator('json', issueLicenseBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    const [product] = await db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.id), eq(products.id, body.productId)))
    if (!product) return c.json({ error: 'product not found' }, 404)

    // 80-bit keys collide only in theory; the loop is a courtesy and the
    // unique index on licenses.key is the real backstop.
    let key = generateLicenseKey()
    for (let attempt = 0; attempt < 3; attempt++) {
      const [dupe] = await db.select({ id: licenses.id }).from(licenses).where(eq(licenses.key, key))
      if (!dupe) break
      key = generateLicenseKey()
    }

    const id = newId('license')
    await db.insert(licenses).values({
      id,
      tenantId: tenant.id,
      productId: product.id,
      key,
      buyerEmail: body.buyerEmail,
      entitlementType: product.entitlementType,
      // Snapshot: later product edits must not retroactively change
      // already-issued licenses.
      maxActivations: product.maxActivations,
      source: 'manual',
    })
    await db.insert(licenseEvents).values({
      id: newId('licenseEvent'),
      tenantId: tenant.id,
      licenseId: id,
      type: 'issued',
      payload: { source: 'manual', productId: product.id },
    })

    const [created] = await db.select().from(licenses).where(eq(licenses.id, id))
    return c.json({ license: created }, 201)
  },
)

export default route
