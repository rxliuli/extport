import { decryptJson, newId } from '@extport/shared'
import { and, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { describeRoute } from 'hono-openapi'
import { licenseEvents, licenses, paymentCredentials, plans, tenants, type Tenant } from '../db'
import { uniqueLicenseKey } from '../lib/license-key'
import { sendLicenseEmail } from '../lib/licensing-email'
import { tenantDek } from '../lib/kms'
import { verifyStripeSignature } from '../lib/stripe'
import type { AppEnv } from '../middleware/auth'

// BYO-Stripe fulfillment: the tenant points their Stripe webhook
// (checkout.session.completed, charge.refunded, charge.dispute.created)
// at /api/v1/licensing/webhooks/stripe/:tenantId and puts
// `extport_plan = <plan id>` in their Payment Link's metadata —
// zero code on their side. Signature verification is the only
// authentication; the per-tenant URL merely selects which secret to
// verify against. See docs/licensing.md.
//
// Status-code contract with Stripe's retry behavior: 2xx = handled or
// deliberately ignored (sessions without extport_plan metadata belong
// to the tenant's other tooling — the license-kit coexistence case);
// 5xx = fulfillment blocked (unknown plan id, missing buyer email,
// email send failure) so Stripe retries and, when it keeps failing,
// surfaces the failing webhook to the tenant.

interface StripeCheckoutSession {
  id: string
  payment_status?: string
  payment_intent?: string | { id: string } | null
  customer_details?: { email?: string | null } | null
  metadata?: Record<string, string> | null
}

interface StripeChargeLike {
  payment_intent?: string | { id: string } | null
}

interface StripeEvent {
  type: string
  data: { object: unknown }
}

function paymentIntentId(object: { payment_intent?: string | { id: string } | null }): string | null {
  return typeof object.payment_intent === 'string' ? object.payment_intent : (object.payment_intent?.id ?? null)
}

const route = new Hono<AppEnv>()

route.post(
  '/:tenantId',
  describeRoute({
    summary: 'Stripe webhook receiver',
    description: 'Set this URL (with your tenant id) as a webhook endpoint in Stripe. Authenticated by webhook signature.',
    responses: { 200: { description: 'Handled or ignored' }, 400: { description: 'Bad signature' }, 404: { description: 'Unknown tenant or no stripe credential' } },
  }),
  async (c) => {
    const db = c.get('db')
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, c.req.param('tenantId')))
    if (!tenant) return c.json({ error: 'not found' }, 404)
    const [credential] = await db
      .select()
      .from(paymentCredentials)
      .where(and(eq(paymentCredentials.tenantId, tenant.id), eq(paymentCredentials.provider, 'stripe')))
    if (!credential) return c.json({ error: 'not found' }, 404)

    const signature = c.req.header('stripe-signature')
    if (!signature) return c.json({ error: 'missing stripe-signature header' }, 400)
    // The exact raw bytes are what's signed — never the re-serialized JSON.
    const rawBody = await c.req.text()
    const dek = await tenantDek(c.env, tenant)
    const { webhookSecret } = (await decryptJson(dek, credential.encryptedPayload)) as { webhookSecret: string }
    if (!(await verifyStripeSignature(webhookSecret, rawBody, signature))) {
      return c.json({ error: 'invalid signature' }, 400)
    }

    let event: StripeEvent
    try {
      event = JSON.parse(rawBody) as StripeEvent
    } catch {
      return c.json({ error: 'invalid payload' }, 400)
    }

    switch (event.type) {
      case 'checkout.session.completed':
        return handleCheckoutCompleted(c, tenant, event.data.object as StripeCheckoutSession)
      case 'charge.refunded':
      case 'charge.dispute.created':
        return handleRefundOrDispute(c, tenant, event.type, event.data.object as StripeChargeLike)
      default:
        return c.json({ status: 'ignored', type: event.type })
    }
  },
)

async function handleCheckoutCompleted(c: Context<AppEnv>, tenant: Tenant, session: StripeCheckoutSession) {
  const db = c.get('db')
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return c.json({ status: 'ignored', reason: `payment_status=${session.payment_status}` })
  }
  const planId = session.metadata?.['extport_plan']
  // Not an extport sale — the tenant's other fulfillment tooling owns it.
  if (!planId) return c.json({ status: 'ignored', reason: 'no extport_plan metadata' })

  const buyerEmail = session.customer_details?.email
  if (!buyerEmail) return c.json({ error: 'checkout session has no buyer email' }, 500)
  // Zero-total sessions (100% promo codes) have no PaymentIntent; the
  // session id is equally unique and refunds can't occur for them anyway.
  const sourceRef = paymentIntentId(session) ?? session.id

  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.tenantId, tenant.id)))
  if (!plan) return c.json({ error: `extport_plan "${planId}" does not match a plan of this tenant` }, 500)

  const [dupe] = await db.select({ id: licenses.id }).from(licenses).where(eq(licenses.sourceRef, sourceRef))
  // No email re-send on replays: a retry that reaches here after an email
  // failure loses the email, but re-sending would double-deliver on
  // Stripe's routine duplicate deliveries — the worse trade.
  if (dupe) return c.json({ status: 'already_processed' })

  const key = await uniqueLicenseKey(db)
  const licenseId = newId('license')
  await db.insert(licenses).values({
    id: licenseId,
    tenantId: tenant.id,
    planId: plan.id,
    key,
    buyerEmail,
    entitlementType: plan.entitlementType,
    maxActivations: plan.maxActivations,
    source: 'stripe_webhook',
    sourceRef,
  })
  await db.insert(licenseEvents).values({
    id: newId('licenseEvent'),
    tenantId: tenant.id,
    licenseId,
    type: 'issued',
    payload: { source: 'stripe_webhook', planId: plan.id, sourceRef },
  })

  await sendLicenseEmail(c.env, {
    to: buyerEmail,
    productName: plan.name,
    tier: plan.tier,
    key,
    maxActivations: plan.maxActivations,
  })
  return c.json({ status: 'processed' })
}

async function handleRefundOrDispute(c: Context<AppEnv>, tenant: Tenant, eventType: string, charge: StripeChargeLike) {
  const db = c.get('db')
  const intentId = paymentIntentId(charge)
  if (!intentId) return c.json({ status: 'ignored', reason: 'no payment_intent' })

  // Unknown ref is a clean ignore, not an error: during the gradual fleet
  // migration both webhook endpoints receive refunds and each side acts
  // only on sales it fulfilled.
  const [license] = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.sourceRef, intentId), eq(licenses.tenantId, tenant.id)))
  if (!license) return c.json({ status: 'ignored', reason: 'unknown payment' })
  if (license.status === 'refunded') return c.json({ status: 'already_processed' })

  await db.update(licenses).set({ status: 'refunded' }).where(eq(licenses.id, license.id))
  await db.insert(licenseEvents).values({
    id: newId('licenseEvent'),
    tenantId: tenant.id,
    licenseId: license.id,
    type: 'revoked',
    payload: { reason: eventType, sourceRef: intentId },
  })
  return c.json({ status: 'processed' })
}

export default route
