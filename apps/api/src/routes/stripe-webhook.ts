import { decryptJson, newId, type SubscriptionStatus } from '@extport/shared'
import { and, eq, lt, or } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { describeRoute } from 'hono-openapi'
import {
  extensions,
  licenseEvents,
  licenses,
  paymentCredentials,
  pendingStripeSubscriptions,
  plans,
  tenants,
  type Db,
  type Tenant,
} from '../db'
import { uniqueLicenseKey } from '../lib/license-key'
import { sendLicenseEmail } from '../lib/licensing-email'
import { tenantDek } from '../lib/kms'
import { verifyStripeSignature } from '../lib/stripe'
import type { AppEnv } from '../middleware/auth'

// BYO-Stripe fulfillment: the tenant points their Stripe webhook
// (checkout.session.completed, checkout.session.async_payment_succeeded,
// customer.subscription.created/updated/deleted, invoice.paid,
// invoice.payment_failed, charge.refunded, charge.dispute.created)
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

type StripeRef = string | { id: string } | null | undefined

interface StripeCheckoutSession {
  id: string
  mode?: 'payment' | 'subscription' | 'setup' | string
  payment_status?: string
  payment_intent?: StripeRef
  subscription?: StripeRef
  client_reference_id?: string | null
  // address is only populated when the Payment Link's billing_address_collection
  // is 'required' — 'auto' (the default) mostly skips it for card payments
  // once automatic_tax is off, since nothing else needs it.
  customer_details?: { email?: string | null; address?: { country?: string | null } | null } | null
  metadata?: Record<string, string> | null
  /** Smallest currency unit; 0 for 100%-promo or free-trial sessions. */
  amount_total?: number | null
  currency?: string | null
}

interface StripeSubscriptionItem {
  current_period_start?: number | null
  current_period_end?: number | null
}

interface StripeSubscription {
  id: string
  status?: string
  // Pre-2025-03-31 top-level fields; removed in 2025-03-31+ (moved to items.data[]).
  current_period_start?: number | null
  current_period_end?: number | null
  cancel_at_period_end?: boolean | null
  trial_start?: number | null
  trial_end?: number | null
  ended_at?: number | null
  items?: { data?: StripeSubscriptionItem[] | null } | null
  metadata?: Record<string, string> | null
}

interface StripeInvoiceLine {
  type?: string
  subscription?: StripeRef
  period?: { start?: number | null; end?: number | null } | null
  parent?: {
    type?: string
    subscription_item_details?: { subscription?: StripeRef } | null
  } | null
}

interface StripeInvoice {
  id?: string
  // Pre-2025-03-31 top-level field; moved in 2025-03-31+ to parent.subscription_details.subscription.
  subscription?: StripeRef
  parent?: {
    type?: string
    subscription_details?: { subscription?: StripeRef } | null
  } | null
  billing_reason?: string | null
  amount_paid?: number | null
  attempt_count?: number | null
  period_start?: number | null
  period_end?: number | null
  lines?: { data?: StripeInvoiceLine[] | null } | null
}

interface StripeChargeLike {
  payment_intent?: StripeRef
}

interface StripeEvent {
  type: string
  created?: number
  data: { object: unknown }
}

function stripeId(ref: StripeRef): string | null {
  return typeof ref === 'string' ? ref : (ref?.id ?? null)
}

function toIsoSeconds(sec: number | null | undefined): string | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null
  return new Date(sec * 1000).toISOString()
}

function extractSubscriptionPeriod(sub: StripeSubscription): {
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
} {
  // Support both legacy top-level fields and Stripe API 2025-03-31+ item-level fields.
  const itemStarts: number[] = []
  const itemEnds: number[] = []
  for (const item of sub.items?.data ?? []) {
    if (typeof item.current_period_start === 'number') itemStarts.push(item.current_period_start)
    if (typeof item.current_period_end === 'number') itemEnds.push(item.current_period_end)
  }
  const startSec =
    typeof sub.current_period_start === 'number'
      ? sub.current_period_start
      : itemStarts.length > 0
        ? Math.min(...itemStarts)
        : sub.status === 'trialing'
          ? sub.trial_start
          : null
  const endSec =
    typeof sub.current_period_end === 'number'
      ? sub.current_period_end
      : itemEnds.length > 0
        ? Math.max(...itemEnds)
        : sub.status === 'trialing'
          ? sub.trial_end
          : null
  return {
    currentPeriodStart: toIsoSeconds(startSec),
    currentPeriodEnd: toIsoSeconds(endSec),
  }
}

function extractInvoiceSubscriptionId(invoice: StripeInvoice): string | null {
  const fromTop = stripeId(invoice.subscription)
  if (fromTop) return fromTop
  const fromParent = stripeId(invoice.parent?.subscription_details?.subscription)
  if (fromParent) return fromParent
  for (const line of invoice.lines?.data ?? []) {
    const fromLine = stripeId(line.subscription) ?? stripeId(line.parent?.subscription_item_details?.subscription)
    if (fromLine) return fromLine
  }
  return null
}

function extractInvoicePeriod(invoice: StripeInvoice): {
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
} {
  const lines = invoice.lines?.data ?? []
  const subLines = lines.filter(
    (l) => l.type === 'subscription' || Boolean(l.parent?.subscription_item_details) || Boolean(l.subscription),
  )
  const targetLines = subLines.length > 0 ? subLines : lines
  const starts: number[] = []
  const ends: number[] = []
  for (const line of targetLines) {
    if (typeof line.period?.start === 'number') starts.push(line.period.start)
    if (typeof line.period?.end === 'number') ends.push(line.period.end)
  }
  const startSec = starts.length > 0 ? Math.min(...starts) : invoice.period_start
  const endSec = ends.length > 0 ? Math.max(...ends) : invoice.period_end
  return {
    currentPeriodStart: toIsoSeconds(startSec),
    currentPeriodEnd: toIsoSeconds(endSec),
  }
}

function mapStripeSubscriptionStatus(status: string | undefined, endedAt?: number | null): SubscriptionStatus | null {
  switch (status) {
    case 'trialing':
      return 'trialing'
    case 'active':
      return 'active'
    case 'past_due':
      return 'past_due'
    case 'canceled':
      // If Stripe already set ended_at in the past/now (immediate cancel), the
      // subscription has ended rather than remaining in end-of-period grace.
      if (typeof endedAt === 'number' && endedAt * 1000 <= Date.now()) return 'expired'
      return 'canceled'
    case 'unpaid':
    case 'incomplete_expired':
    case 'paused':
      return 'expired'
    default:
      // 'incomplete' (or unknown) is transient before checkout finishes; ignore so
      // out-of-order deliveries never downgrade an active subscription.
      return null
  }
}

const PENDING_SUBSCRIPTION_TTL_MS = 7 * 24 * 60 * 60 * 1000

async function upsertPendingSubscription(
  db: Db,
  tenantId: string,
  stripeSubscriptionId: string,
  patch: {
    subscriptionStatus: SubscriptionStatus
    currentPeriodStart?: string | null
    currentPeriodEnd?: string | null
    cancelAtPeriodEnd?: boolean
    preserveTrialOnZeroInitialInvoice?: boolean
    eventCreated?: number
  },
) {
  // Prune stale deferred entries for this tenant (e.g. subscriptions on the
  // same Stripe account that do not belong to extport) so the staging table
  // stays bounded without a cron job.
  const staleBefore = new Date(Date.now() - PENDING_SUBSCRIPTION_TTL_MS).toISOString()
  await db
    .delete(pendingStripeSubscriptions)
    .where(
      and(eq(pendingStripeSubscriptions.tenantId, tenantId), lt(pendingStripeSubscriptions.updatedAt, staleBefore)),
    )

  const [existing] = await db
    .select()
    .from(pendingStripeSubscriptions)
    .where(
      and(
        eq(pendingStripeSubscriptions.tenantId, tenantId),
        eq(pendingStripeSubscriptions.stripeSubscriptionId, stripeSubscriptionId),
      ),
    )

  if (existing?.lastEventCreated && patch.eventCreated && patch.eventCreated < existing.lastEventCreated) {
    return
  }

  const nextStatus =
    patch.preserveTrialOnZeroInitialInvoice && existing?.subscriptionStatus === 'trialing'
      ? 'trialing'
      : patch.subscriptionStatus

  if (existing) {
    await db
      .update(pendingStripeSubscriptions)
      .set({
        subscriptionStatus: nextStatus,
        currentPeriodStart: patch.currentPeriodStart ?? existing.currentPeriodStart,
        currentPeriodEnd: patch.currentPeriodEnd ?? existing.currentPeriodEnd,
        cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? existing.cancelAtPeriodEnd,
        lastEventCreated: patch.eventCreated ?? existing.lastEventCreated,
      })
      .where(eq(pendingStripeSubscriptions.id, existing.id))
  } else {
    await db.insert(pendingStripeSubscriptions).values({
      id: newId('pendingStripeSubscription'),
      tenantId,
      stripeSubscriptionId,
      subscriptionStatus: nextStatus,
      currentPeriodStart: patch.currentPeriodStart ?? null,
      currentPeriodEnd: patch.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? false,
      lastEventCreated: patch.eventCreated ?? null,
    })
  }
}

const route = new Hono<AppEnv>()

route.post(
  '/:tenantId',
  describeRoute({
    summary: 'Stripe webhook receiver',
    description:
      'Set this URL (with your tenant id) as a webhook endpoint in Stripe. Authenticated by webhook signature.',
    tags: ['Licensing'],
    security: [],
    responses: {
      200: { description: 'Handled or ignored' },
      400: { description: 'Bad signature' },
      404: { description: 'Unknown tenant or no stripe credential' },
    },
  }),
  async (c) => {
    const db = c.get('db')
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, c.req.param('tenantId')))
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
      case 'checkout.session.async_payment_succeeded':
        return handleCheckoutCompleted(c, tenant, event.data.object as StripeCheckoutSession)
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return handleSubscriptionChange(c, tenant, event.type, event.data.object as StripeSubscription, event.created)
      case 'customer.subscription.deleted':
        return handleSubscriptionDeleted(c, tenant, event.data.object as StripeSubscription, event.created)
      case 'invoice.paid':
        return handleInvoicePaid(c, tenant, event.data.object as StripeInvoice, event.created)
      case 'invoice.payment_failed':
        return handleInvoicePaymentFailed(c, tenant, event.data.object as StripeInvoice, event.created)
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
  if (session.mode === 'setup') {
    return c.json({ status: 'ignored', reason: 'mode=setup' })
  }
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return c.json({ status: 'ignored', reason: `payment_status=${session.payment_status}` })
  }
  const planId = session.metadata?.['extport_plan']
  // Not an extport sale — the tenant's other fulfillment tooling owns it.
  if (!planId) return c.json({ status: 'ignored', reason: 'no extport_plan metadata' })

  const buyerEmail = session.customer_details?.email
  if (!buyerEmail) return c.json({ error: 'checkout session has no buyer email' }, 500)
  const subscriptionId = stripeId(session.subscription)
  const externalUserId = session.client_reference_id?.trim() || null
  // Zero-total / free-trial / subscription sessions have no PaymentIntent on the
  // session itself; fall back to the subscription id (for recurring) or session id.
  const sourceRef = stripeId(session.payment_intent) ?? subscriptionId ?? session.id

  const [row] = await db
    .select({ plan: plans, extension: extensions })
    .from(plans)
    .innerJoin(extensions, eq(plans.extensionId, extensions.id))
    .where(and(eq(plans.id, planId), eq(plans.tenantId, tenant.id)))
  if (!row) return c.json({ error: `extport_plan "${planId}" does not match a plan of this tenant` }, 500)
  const { plan, extension } = row

  const [dupe] = await db
    .select({ id: licenses.id })
    .from(licenses)
    .where(
      or(
        eq(licenses.sourceRef, sourceRef),
        eq(licenses.checkoutSessionId, session.id),
        ...(subscriptionId ? [eq(licenses.stripeSubscriptionId, subscriptionId)] : []),
      ),
    )
  // No email re-send on replays: a retry that reaches here after an email
  // failure loses the email, but re-sending would double-deliver on
  // Stripe's routine duplicate deliveries — the worse trade.
  if (dupe) return c.json({ status: 'already_processed' })

  const isSubscriptionCheckout = session.mode === 'subscription' || Boolean(subscriptionId)
  if (isSubscriptionCheckout && plan.entitlementType !== 'recurring') {
    return c.json(
      { error: `extport_plan "${planId}" is ${plan.entitlementType}, cannot fulfill a subscription checkout` },
      500,
    )
  }
  if (!isSubscriptionCheckout && plan.entitlementType === 'recurring') {
    return c.json({ error: `extport_plan "${planId}" is recurring, cannot fulfill a one-time payment checkout` }, 500)
  }

  let pending: typeof pendingStripeSubscriptions.$inferSelect | undefined
  if (subscriptionId) {
    ;[pending] = await db
      .select()
      .from(pendingStripeSubscriptions)
      .where(
        and(
          eq(pendingStripeSubscriptions.tenantId, tenant.id),
          eq(pendingStripeSubscriptions.stripeSubscriptionId, subscriptionId),
        ),
      )
  }

  const isRecurring = plan.entitlementType === 'recurring'
  const subscriptionStatus: SubscriptionStatus | null = pending
    ? pending.subscriptionStatus
    : isRecurring
      ? 'active'
      : null
  const currentPeriodStart = pending?.currentPeriodStart ?? null
  const currentPeriodEnd = pending?.currentPeriodEnd ?? null
  const cancelAtPeriodEnd = pending?.cancelAtPeriodEnd ?? false

  const key = await uniqueLicenseKey(db)
  const licenseId = newId('license')
  await db.insert(licenses).values({
    id: licenseId,
    tenantId: tenant.id,
    planId: plan.id,
    key,
    buyerEmail,
    externalUserId,
    entitlementType: plan.entitlementType,
    maxActivations: plan.maxActivations,
    source: 'stripe_webhook',
    sourceRef,
    checkoutSessionId: session.id,
    stripeSubscriptionId: subscriptionId,
    subscriptionStatus,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd,
    // Snapshot the sale amount — the future basis for percentage-based
    // licensing billing. Zero (100%-off promo / free trial) is a real, meaningful value.
    amountTotal: session.amount_total ?? null,
    currency: session.currency ?? null,
    country: session.customer_details?.address?.country ?? null,
  })
  if (pending) {
    await db.delete(pendingStripeSubscriptions).where(eq(pendingStripeSubscriptions.id, pending.id))
  }
  await db.insert(licenseEvents).values({
    id: newId('licenseEvent'),
    tenantId: tenant.id,
    licenseId,
    type: 'issued',
    payload: {
      source: 'stripe_webhook',
      planId: plan.id,
      sourceRef,
      ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
      ...(externalUserId ? { externalUserId } : {}),
    },
  })

  await sendLicenseEmail(c.env, {
    to: buyerEmail,
    productName: extension.name,
    tier: plan.tier,
    key,
    maxActivations: plan.maxActivations,
    entitlementType: plan.entitlementType,
    subscriptionStatus,
    currentPeriodEnd,
    supportUrl: tenant.settings.supportUrl ?? null,
    billingPortalUrl: tenant.settings.billingPortalUrl ?? null,
  })
  return c.json({ status: 'processed' })
}

async function handleSubscriptionChange(
  c: Context<AppEnv>,
  tenant: Tenant,
  eventType: 'customer.subscription.created' | 'customer.subscription.updated',
  sub: StripeSubscription,
  eventCreated?: number,
) {
  const db = c.get('db')
  if (!sub?.id) return c.json({ status: 'ignored', reason: 'no subscription id' })

  const mappedStatus = mapStripeSubscriptionStatus(sub.status, sub.ended_at)
  if (!mappedStatus) return c.json({ status: 'ignored', reason: `subscription_status=${sub.status}` })

  const { currentPeriodStart, currentPeriodEnd } = extractSubscriptionPeriod(sub)
  const cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end)

  const [license] = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.stripeSubscriptionId, sub.id), eq(licenses.tenantId, tenant.id)))
  if (!license) {
    await upsertPendingSubscription(db, tenant.id, sub.id, {
      subscriptionStatus: mappedStatus,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      eventCreated,
    })
    return c.json({ status: 'deferred' })
  }

  // Never let an out-of-order `customer.subscription.created` overwrite a
  // later lifecycle state (e.g. already past_due, canceled, or expired).
  const isOutOfOrderCreate =
    eventType === 'customer.subscription.created' &&
    (license.subscriptionStatus === 'past_due' ||
      license.subscriptionStatus === 'canceled' ||
      license.subscriptionStatus === 'expired')

  const nextStatus = isOutOfOrderCreate ? license.subscriptionStatus : mappedStatus
  const nextStart = currentPeriodStart ?? license.currentPeriodStart
  const nextEnd = currentPeriodEnd ?? license.currentPeriodEnd
  const nextCancelAtPeriodEnd = isOutOfOrderCreate ? license.cancelAtPeriodEnd : cancelAtPeriodEnd

  if (
    nextStatus === license.subscriptionStatus &&
    nextStart === license.currentPeriodStart &&
    nextEnd === license.currentPeriodEnd &&
    nextCancelAtPeriodEnd === license.cancelAtPeriodEnd
  ) {
    return c.json({ status: 'already_processed' })
  }

  await db
    .update(licenses)
    .set({
      subscriptionStatus: nextStatus,
      currentPeriodStart: nextStart,
      currentPeriodEnd: nextEnd,
      cancelAtPeriodEnd: nextCancelAtPeriodEnd,
    })
    .where(eq(licenses.id, license.id))

  const statusOrCancelChanged =
    nextStatus !== license.subscriptionStatus || nextCancelAtPeriodEnd !== license.cancelAtPeriodEnd
  if (eventType === 'customer.subscription.updated' || statusOrCancelChanged) {
    const logType =
      nextStatus === 'canceled' && license.subscriptionStatus !== 'canceled'
        ? 'canceled'
        : nextStatus === 'expired' && license.subscriptionStatus !== 'expired'
          ? 'expired'
          : 'subscription_updated'
    await db.insert(licenseEvents).values({
      id: newId('licenseEvent'),
      tenantId: tenant.id,
      licenseId: license.id,
      type: logType,
      payload: {
        eventType,
        stripeSubscriptionId: sub.id,
        subscriptionStatus: nextStatus,
        cancelAtPeriodEnd: nextCancelAtPeriodEnd,
        currentPeriodStart: nextStart,
        currentPeriodEnd: nextEnd,
      },
    })
  }
  return c.json({ status: 'processed' })
}

async function handleSubscriptionDeleted(
  c: Context<AppEnv>,
  tenant: Tenant,
  sub: StripeSubscription,
  eventCreated?: number,
) {
  const db = c.get('db')
  if (!sub?.id) return c.json({ status: 'ignored', reason: 'no subscription id' })

  const { currentPeriodStart, currentPeriodEnd } = extractSubscriptionPeriod(sub)
  const cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end)

  const [license] = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.stripeSubscriptionId, sub.id), eq(licenses.tenantId, tenant.id)))
  if (!license) {
    await upsertPendingSubscription(db, tenant.id, sub.id, {
      subscriptionStatus: 'expired',
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      eventCreated,
    })
    return c.json({ status: 'deferred' })
  }

  if (license.subscriptionStatus === 'expired') return c.json({ status: 'already_processed' })

  await db
    .update(licenses)
    .set({
      subscriptionStatus: 'expired',
      currentPeriodStart: currentPeriodStart ?? license.currentPeriodStart,
      currentPeriodEnd: currentPeriodEnd ?? license.currentPeriodEnd,
      cancelAtPeriodEnd,
    })
    .where(eq(licenses.id, license.id))

  await db.insert(licenseEvents).values({
    id: newId('licenseEvent'),
    tenantId: tenant.id,
    licenseId: license.id,
    type: 'expired',
    payload: {
      stripeSubscriptionId: sub.id,
      endedAt: toIsoSeconds(sub.ended_at),
      currentPeriodEnd: currentPeriodEnd ?? license.currentPeriodEnd,
    },
  })
  return c.json({ status: 'processed' })
}

async function handleInvoicePaid(c: Context<AppEnv>, tenant: Tenant, invoice: StripeInvoice, eventCreated?: number) {
  const db = c.get('db')
  const subscriptionId = extractInvoiceSubscriptionId(invoice)
  if (!subscriptionId) return c.json({ status: 'ignored', reason: 'no subscription on invoice' })

  const { currentPeriodStart, currentPeriodEnd } = extractInvoicePeriod(invoice)
  const isInitialTrialInvoice = invoice.billing_reason === 'subscription_create' && (invoice.amount_paid ?? 0) === 0

  const [license] = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.stripeSubscriptionId, subscriptionId), eq(licenses.tenantId, tenant.id)))
  if (!license) {
    await upsertPendingSubscription(db, tenant.id, subscriptionId, {
      subscriptionStatus: 'active',
      currentPeriodStart,
      currentPeriodEnd,
      preserveTrialOnZeroInitialInvoice: isInitialTrialInvoice,
      eventCreated,
    })
    return c.json({ status: 'deferred' })
  }

  const nextStatus: SubscriptionStatus =
    isInitialTrialInvoice && license.subscriptionStatus === 'trialing' ? 'trialing' : 'active'
  const nextStart = currentPeriodStart ?? license.currentPeriodStart
  const nextEnd = currentPeriodEnd ?? license.currentPeriodEnd

  const unchanged =
    nextStatus === license.subscriptionStatus &&
    nextStart === license.currentPeriodStart &&
    nextEnd === license.currentPeriodEnd

  const existingEvents = invoice.id
    ? await db.select().from(licenseEvents).where(eq(licenseEvents.licenseId, license.id))
    : []
  const alreadyLoggedInvoice = invoice.id
    ? existingEvents.some((e) => e.type === 'renewed' && e.payload['invoiceId'] === invoice.id)
    : false

  if (unchanged && (alreadyLoggedInvoice || invoice.billing_reason === 'subscription_create')) {
    return c.json({ status: 'already_processed' })
  }

  if (!unchanged) {
    await db
      .update(licenses)
      .set({
        subscriptionStatus: nextStatus,
        currentPeriodStart: nextStart,
        currentPeriodEnd: nextEnd,
      })
      .where(eq(licenses.id, license.id))
  }

  if (invoice.billing_reason !== 'subscription_create' && !alreadyLoggedInvoice) {
    await db.insert(licenseEvents).values({
      id: newId('licenseEvent'),
      tenantId: tenant.id,
      licenseId: license.id,
      type: 'renewed',
      payload: {
        stripeSubscriptionId: subscriptionId,
        invoiceId: invoice.id ?? null,
        billingReason: invoice.billing_reason ?? null,
        currentPeriodStart: nextStart,
        currentPeriodEnd: nextEnd,
      },
    })
  }
  return c.json({ status: 'processed' })
}

async function handleInvoicePaymentFailed(
  c: Context<AppEnv>,
  tenant: Tenant,
  invoice: StripeInvoice,
  eventCreated?: number,
) {
  const db = c.get('db')
  const subscriptionId = extractInvoiceSubscriptionId(invoice)
  if (!subscriptionId) return c.json({ status: 'ignored', reason: 'no subscription on invoice' })

  const [license] = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.stripeSubscriptionId, subscriptionId), eq(licenses.tenantId, tenant.id)))
  if (!license) {
    await upsertPendingSubscription(db, tenant.id, subscriptionId, {
      subscriptionStatus: 'past_due',
      eventCreated,
    })
    return c.json({ status: 'deferred' })
  }

  if (license.subscriptionStatus === 'expired') {
    return c.json({ status: 'ignored', reason: 'subscription already expired' })
  }

  if (invoice.id) {
    const existingEvents = await db.select().from(licenseEvents).where(eq(licenseEvents.licenseId, license.id))
    const alreadyLogged = existingEvents.some(
      (e) => e.type === 'payment_failed' && e.payload['invoiceId'] === invoice.id,
    )
    if (alreadyLogged && license.subscriptionStatus === 'past_due') {
      return c.json({ status: 'already_processed' })
    }
  } else if (license.subscriptionStatus === 'past_due') {
    return c.json({ status: 'already_processed' })
  }

  await db.update(licenses).set({ subscriptionStatus: 'past_due' }).where(eq(licenses.id, license.id))

  await db.insert(licenseEvents).values({
    id: newId('licenseEvent'),
    tenantId: tenant.id,
    licenseId: license.id,
    type: 'payment_failed',
    payload: {
      stripeSubscriptionId: subscriptionId,
      invoiceId: invoice.id ?? null,
      attemptCount: invoice.attempt_count ?? null,
    },
  })
  return c.json({ status: 'processed' })
}

async function handleRefundOrDispute(c: Context<AppEnv>, tenant: Tenant, eventType: string, charge: StripeChargeLike) {
  const db = c.get('db')
  const intentId = stripeId(charge.payment_intent)
  if (!intentId) return c.json({ status: 'ignored', reason: 'no payment_intent' })

  // Unknown ref is a clean ignore, not an error: during the gradual fleet
  // migration both webhook endpoints receive refunds and each side acts
  // only on sales it fulfilled.
  const [license] = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.sourceRef, intentId), eq(licenses.tenantId, tenant.id)))
  if (!license) return c.json({ status: 'ignored', reason: 'unknown payment' })
  // Recurring subscriptions manage cancellation/termination via
  // customer.subscription.deleted/updated; never blindly nuke a recurring
  // license on a partial or single-invoice charge refund.
  if (license.entitlementType === 'recurring') {
    return c.json({ status: 'ignored', reason: 'recurring subscription refund managed via subscription lifecycle' })
  }
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
