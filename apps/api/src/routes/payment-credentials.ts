import { encryptJson, newId } from '@extport/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { paymentCredentials, type PaymentCredential } from '../db'
import { tenantDek } from '../lib/kms'
import { loadStripeCredential, type StripeCredentialPayload } from '../lib/stripe-credentials'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireSession, type AppEnv } from '../middleware/auth'

// Stripe credentials (webhook signing secret and/or Restricted Key),
// envelope-encrypted like store credentials and, like them, dashboard-managed
// only — an API key must never read or write payment credentials.
const route = new Hono<AppEnv>()

route.use('*', requireSession, requireActiveTenant)

function publicView(row: PaymentCredential) {
  return {
    id: row.id,
    provider: row.provider,
    hint: row.hint,
    hasWebhookSecret: Boolean(row.hint),
    apiKeyHint: row.apiKeyHint ?? null,
    hasApiKey: Boolean(row.apiKeyHint),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

route.get(
  '/',
  describeRoute({
    summary: 'List payment credentials',
    tags: ['Licensing'],
    security: [{ session: [] }],
    responses: { 200: { description: 'OK' } },
  }),
  async (c) => {
    const rows = await c
      .get('db')
      .select()
      .from(paymentCredentials)
      .where(eq(paymentCredentials.tenantId, c.get('tenant').id))
    return c.json({ credentials: rows.map(publicView) })
  },
)

const putCredentialBodySchema = v.pipe(
  v.object({
    provider: v.literal('stripe', 'provider must be "stripe"'),
    // whsec_... from the Stripe webhook endpoint's settings page.
    webhookSecret: v.optional(
      v.pipe(
        v.string('webhookSecret must be a string'),
        v.trim(),
        v.minLength(8, 'webhookSecret looks too short'),
        v.maxLength(200, 'webhookSecret looks too long'),
      ),
    ),
    // rk_... (recommended Restricted Key) or sk_...; null clears it when webhookSecret remains.
    apiKey: v.optional(
      v.nullable(
        v.pipe(
          v.string('apiKey must be a string'),
          v.trim(),
          v.minLength(12, 'apiKey looks too short'),
          v.maxLength(250, 'apiKey looks too long'),
          v.check((s) => s.startsWith('rk_') || s.startsWith('sk_'), 'apiKey must start with "rk_" or "sk_"'),
        ),
      ),
    ),
  }),
  v.check((b) => b.webhookSecret !== undefined || b.apiKey !== undefined, 'provide webhookSecret or apiKey'),
)

route.post(
  '/',
  describeRoute({
    summary: 'Store a payment credential',
    description:
      'Upserts the (tenant, provider) credential — updating webhookSecret or apiKey merges with the existing secret so neither wipes the other. Pass apiKey: null to clear the API key while keeping webhookSecret. Secrets are never returned.',
    tags: ['Licensing'],
    security: [{ session: [] }],
    responses: { 200: { description: 'Stored' } },
  }),
  validator('json', putCredentialBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

    const existing = await loadStripeCredential(c.env, db, tenant)
    const nextPayload: StripeCredentialPayload = {}
    const nextWebhookSecret = body.webhookSecret ?? existing?.webhookSecret
    if (nextWebhookSecret) nextPayload.webhookSecret = nextWebhookSecret
    const nextApiKey = body.apiKey === null ? undefined : (body.apiKey ?? existing?.apiKey)
    if (nextApiKey) nextPayload.apiKey = nextApiKey

    if (!nextPayload.webhookSecret && !nextPayload.apiKey) {
      return c.json({ error: 'cannot clear apiKey when no webhookSecret is configured' }, 400)
    }

    const dek = await tenantDek(c.env, tenant)
    const encryptedPayload = await encryptJson(dek, nextPayload)
    const hint = nextPayload.webhookSecret ? nextPayload.webhookSecret.slice(-4) : ''
    const apiKeyHint = nextPayload.apiKey ? nextPayload.apiKey.slice(-4) : null

    if (existing) {
      await db
        .update(paymentCredentials)
        .set({ encryptedPayload, hint, apiKeyHint, keyVersion: tenant.dekKeyVersion })
        .where(eq(paymentCredentials.id, existing.row.id))
    } else {
      await db.insert(paymentCredentials).values({
        id: newId('paymentCredential'),
        tenantId: tenant.id,
        provider: body.provider,
        hint,
        apiKeyHint,
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
