import { encryptJson, newId } from '@extport/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { paymentCredentials, type PaymentCredential } from '../db'
import { tenantDek } from '../lib/kms'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireSession, type AppEnv } from '../middleware/auth'

// The Stripe webhook signing secret, envelope-encrypted like store
// credentials and, like them, dashboard-managed only — an API key must
// never read or write payment credentials.
const route = new Hono<AppEnv>()

route.use('*', requireSession, requireActiveTenant)

function publicView(row: PaymentCredential) {
  return { id: row.id, provider: row.provider, hint: row.hint, createdAt: row.createdAt, updatedAt: row.updatedAt }
}

route.get(
  '/',
  describeRoute({ summary: 'List payment credentials', responses: { 200: { description: 'OK' } } }),
  async (c) => {
    const rows = await c
      .get('db')
      .select()
      .from(paymentCredentials)
      .where(eq(paymentCredentials.tenantId, c.get('tenant').id))
    return c.json({ credentials: rows.map(publicView) })
  },
)

const putCredentialBodySchema = v.object({
  provider: v.literal('stripe', 'provider must be "stripe"'),
  // whsec_... from the Stripe webhook endpoint's settings page.
  webhookSecret: v.pipe(
    v.string('webhookSecret is required'),
    v.trim(),
    v.minLength(8, 'webhookSecret looks too short'),
    v.maxLength(200, 'webhookSecret looks too long'),
  ),
})

route.post(
  '/',
  describeRoute({
    summary: 'Store a payment credential',
    description: 'Upserts the (tenant, provider) credential — storing again replaces the secret. The secret is never returned.',
    responses: { 200: { description: 'Stored' } },
  }),
  validator('json', putCredentialBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    const dek = await tenantDek(c.env, tenant)
    const encryptedPayload = await encryptJson(dek, { webhookSecret: body.webhookSecret })
    const hint = body.webhookSecret.slice(-4)

    const [existing] = await db
      .select({ id: paymentCredentials.id })
      .from(paymentCredentials)
      .where(and(eq(paymentCredentials.tenantId, tenant.id), eq(paymentCredentials.provider, body.provider)))
    if (existing) {
      await db
        .update(paymentCredentials)
        .set({ encryptedPayload, hint, keyVersion: tenant.dekKeyVersion })
        .where(eq(paymentCredentials.id, existing.id))
    } else {
      await db.insert(paymentCredentials).values({
        id: newId('paymentCredential'),
        tenantId: tenant.id,
        provider: body.provider,
        hint,
        encryptedPayload,
        keyVersion: tenant.dekKeyVersion,
      })
    }
    const [row] = await db
      .select()
      .from(paymentCredentials)
      .where(and(eq(paymentCredentials.tenantId, tenant.id), eq(paymentCredentials.provider, body.provider)))
    return c.json({ credential: publicView(row!) })
  },
)

export default route
