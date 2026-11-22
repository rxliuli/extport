import { newId, type SubscriptionStatus } from '@extport/shared'
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
  subscriptionEvents,
  subscriptions,
  tenants,
  type Db,
  type Tenant,
} from '../db'
import { uniqueLicenseKey } from '../lib/license-key'
import { sendLicenseEmail } from '../lib/licensing-email'
import { verifyStripeSignature } from '../lib/stripe'
import type { AppEnv } from '../middleware/auth'

// BYO-Stripe fulfillment: the tenant points their Stripe webhook
// (checkout.session.completed, checkout.session.async_payment_succeeded,
// customer.subscription.created/updated/deleted, invoice.paid,
// invoice.payment_failed, charge.refunded, charge.dispute.created)
// at /api/v1/licensing/webhooks/stripe/:tenantId and puts
// `extport_plan = <plan id>` in their Checkout / Payment Link metadata.
//
// Clean separation:
// - `recurring` plans fulfill into `subscriptions` + `subscription_events`
//   (account-based recurring billing — no activation key, no key email).
// - `perpetual` plans fulfill into `licenses` + `license_events` + activation email.
//
// Status-code contract with Stripe's retry behavior: 2xx = handled or
// deliberately ignored; 5xx = fulfillment blocked (unknown plan id, missing
// buyer email, plan/mode mismatch, email send failure) so Stripe retries.

type StripeRef = string | { id: string } | null | undefined

interface StripeCheckoutSession {
  id: string
  mode?: 'payment' | 'subscription' | 'setup' | string
  payment_status?: string
  customer?: StripeRef
  payment_intent?: StripeRef
  subscription?: StripeRef
  client_reference_id?: string | null
  customer_details?: { email?: string | null; address?: { country?: string | null } | null } | null
  metadata?: Record<string, string> | null
  /** Smallest currency unit; 0 for 100%-promo or free-trial sessions. */
  amount_total?: number | null
  currency?: string | null
}

interface StripeSubscriptionItem {
  current_period_start?: number | null
  current_period_end?: number | null
  price?: StripeRef
  plan?: StripeRef
}

interface StripeSubscription {
  id: string
  customer?: StripeRef
  status?: string
  // Pre-2025-03-31 top-level fields; removed in 2025-03-31+ (moved to items.data[]).
  current_period_start?: number | null
  current_period_end?: number | null
  cancel_at_period_end?: boolean | null
  /** Scheduled cancellation timestamp — Stripe Billing Portal uses this in flexible billing mode while leaving cancel_at_period_end=false. */
  cancel_at?: number | null
  schedule?: StripeRef
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
  customer?: StripeRef
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
  /** Present on Connect webhook events: the connected Standard account ID (acct_...). */
  account?: string
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
    stripeCustomerId?: string | null
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
        stripeCustomerId: patch.stripeCustomerId ?? existing.stripeCustomerId,
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
      stripeCustomerId: patch.stripeCustomerId ?? null,
      subscriptionStatus: nextStatus,
      currentPeriodStart: patch.currentPeriodStart ?? null,
      currentPeriodEnd: patch.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? false,
      lastEventCreated: patch.eventCreated ?? null,
    })
  }
}

const route = new Hono<AppEnv>()

function dispatchStripeEvent(c: Context<AppEnv>, tenant: Tenant, event: StripeEvent) {
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
}

// Registered before /:tenantId so /connect always hits the platform Connect endpoint.
route.post(
  '/connect',
  describeRoute({
    summary: 'Stripe Connect platform webhook receiver',
    description:
      'Single platform-level Connect webhook endpoint for all OAuth-connected Standard accounts. Routes events by event.account (acct_…) and handles account.application.deauthorized.',
    tags: ['Licensing'],
    security: [],
    responses: {
      200: { description: 'Handled or ignored' },
      400: { description: 'Bad signature' },
      404: { description: 'Connect webhook secret not configured' },
    },
  }),
  async (c) => {
    const secret = c.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim()
    if (!secret) return c.json({ error: 'not found' }, 404)

    const signature = c.req.header('stripe-signature')
    if (!signature) return c.json({ error: 'missing stripe-signature header' }, 400)
    const rawBody = await c.req.text()
    if (!(await verifyStripeSignature(secret, rawBody, signature))) {
      return c.json({ error: 'invalid signature' }, 400)
    }

    let event: StripeEvent
    try {
      event = JSON.parse(rawBody) as StripeEvent
    } catch {
      return c.json({ error: 'invalid payload' }, 400)
    }

    const accountId = typeof event.account === 'string' && event.account.trim() ? event.account.trim() : null
    if (!accountId) {
      return c.json({ status: 'ignored', reason: 'no account on connect event' })
    }

    const db = c.get('db')
    const [row] = await db
      .select({ credential: paymentCredentials, tenant: tenants })
      .from(paymentCredentials)
      .innerJoin(tenants, eq(paymentCredentials.tenantId, tenants.id))
      .where(and(eq(paymentCredentials.provider, 'stripe'), eq(paymentCredentials.stripeAccountId, accountId)))
    if (!row) {
      return c.json({ status: 'ignored', reason: 'unknown connected account' })
    }

    if (event.type === 'account.application.deauthorized') {
      await db.delete(paymentCredentials).where(eq(paymentCredentials.id, row.credential.id))
      return c.json({ status: 'deauthorized' })
    }

    return dispatchStripeEvent(c, row.tenant, event)
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
  const customerId = stripeId(session.customer)
  const stripeSubId = stripeId(session.subscription)
  const externalUserId = session.client_reference_id?.trim() || null

  const [row] = await db
    .select({ plan: plans, extension: extensions })
    .from(plans)
    .innerJoin(extensions, eq(plans.extensionId, extensions.id))
    .where(and(eq(plans.id, planId), eq(plans.tenantId, tenant.id)))
  if (!row) return c.json({ error: `extport_plan "${planId}" does not match a plan of this tenant` }, 500)
  const { plan, extension } = row

  const isSubscriptionCheckout = session.mode === 'subscription' || Boolean(stripeSubId)
  if (isSubscriptionCheckout && plan.entitlementType !== 'recurring') {
    return c.json(
      { error: `extport_plan "${planId}" is ${plan.entitlementType}, cannot fulfill a subscription checkout` },
      500,
    )
  }
  if (!isSubscriptionCheckout && plan.entitlementType === 'recurring') {
    return c.json({ error: `extport_plan "${planId}" is recurring, cannot fulfill a one-time payment checkout` }, 500)
  }

  // ---- Subscription checkout -> `subscriptions` + `subscription_events` ----
  if (plan.entitlementType === 'recurring') {
    if (!stripeSubId) {
      return c.json({ error: 'subscription checkout session has no subscription id' }, 500)
    }

    const [dupe] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(or(eq(subscriptions.stripeSubscriptionId, stripeSubId), eq(subscriptions.checkoutSessionId, session.id)))
    if (dupe) return c.json({ status: 'already_processed' })

    const [pending] = await db
      .select()
      .from(pendingStripeSubscriptions)
      .where(
        and(
          eq(pendingStripeSubscriptions.tenantId, tenant.id),
          eq(pendingStripeSubscriptions.stripeSubscriptionId, stripeSubId),
        ),
      )

    const status: SubscriptionStatus = pending ? pending.subscriptionStatus : 'active'
    const currentPeriodStart = pending?.currentPeriodStart ?? null
    const currentPeriodEnd = pending?.currentPeriodEnd ?? null
    const cancelAtPeriodEnd = pending?.cancelAtPeriodEnd ?? false

    const subRowId = newId('subscription')
    await db.insert(subscriptions).values({
      id: subRowId,
      tenantId: tenant.id,
      extensionId: extension.id,
      planId: plan.id,
      externalUserId,
      buyerEmail,
      stripeCustomerId: customerId ?? pending?.stripeCustomerId ?? null,
      stripeSubscriptionId: stripeSubId,
      checkoutSessionId: session.id,
      status,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      amountTotal: session.amount_total ?? null,
      currency: session.currency ?? null,
      country: session.customer_details?.address?.country ?? null,
    })
    if (pending) {
      await db.delete(pendingStripeSubscriptions).where(eq(pendingStripeSubscriptions.id, pending.id))
    }
    await db.insert(subscriptionEvents).values({
      id: newId('subscriptionEvent'),
      tenantId: tenant.id,
      subscriptionId: subRowId,
      type: 'created',
      payload: {
        planId: plan.id,
        stripeSubscriptionId: stripeSubId,
        checkoutSessionId: session.id,
        ...(externalUserId ? { externalUserId } : {}),
      },
    })
    return c.json({ status: 'processed' })
  }

  // ---- One-time perpetual checkout -> `licenses` + `license_events` + email ----
  const sourceRef = stripeId(session.payment_intent) ?? session.id

  const [dupe] = await db
    .select({ id: licenses.id })
    .from(licenses)
    .where(or(eq(licenses.sourceRef, sourceRef), eq(licenses.checkoutSessionId, session.id)))
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
    externalUserId,
    entitlementType: plan.entitlementType,
    maxActivations: plan.maxActivations,
    source: 'stripe_webhook',
    sourceRef,
    checkoutSessionId: session.id,
    stripeCustomerId: customerId,
    amountTotal: session.amount_total ?? null,
    currency: session.currency ?? null,
    country: session.customer_details?.address?.country ?? null,
  })
  await db.insert(licenseEvents).values({
    id: newId('licenseEvent'),
    tenantId: tenant.id,
    licenseId,
    type: 'issued',
    payload: {
      source: 'stripe_webhook',
      planId: plan.id,
      sourceRef,
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
    subscriptionStatus: null,
    currentPeriodEnd: null,
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

  const { currentPeriodStart, currentPeriodEnd: extractedEnd } = extractSubscriptionPeriod(sub)
  const cancelAtIso = toIsoSeconds(sub.cancel_at)
  const currentPeriodEnd = extractedEnd ?? cancelAtIso
  const cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end || cancelAtIso)
  const customerId = stripeId(sub.customer)

  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.stripeSubscriptionId, sub.id), eq(subscriptions.tenantId, tenant.id)))
  if (!existing) {
    await upsertPendingSubscription(db, tenant.id, sub.id, {
      stripeCustomerId: customerId,
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
    (existing.status === 'past_due' || existing.status === 'canceled' || existing.status === 'expired')

  const nextStatus = isOutOfOrderCreate ? existing.status : mappedStatus
  const nextStart = currentPeriodStart ?? existing.currentPeriodStart
  const nextEnd = currentPeriodEnd ?? existing.currentPeriodEnd
  const nextCancelAtPeriodEnd = isOutOfOrderCreate ? existing.cancelAtPeriodEnd : cancelAtPeriodEnd
  const nextCustomerId = existing.stripeCustomerId ?? customerId

  const firstItem = sub.items?.data?.[0]
  const currentPriceId = stripeId(firstItem?.price) ?? stripeId(firstItem?.plan)
  let nextPlanId = existing.planId
  if (!isOutOfOrderCreate && currentPriceId) {
    const [matchedPlan] = await db
      .select({ id: plans.id })
      .from(plans)
      .where(
        and(
          eq(plans.tenantId, tenant.id),
          eq(plans.extensionId, existing.extensionId),
          eq(plans.stripePriceId, currentPriceId),
        ),
      )
    if (matchedPlan) nextPlanId = matchedPlan.id
  }

  const incomingScheduleId = stripeId(sub.schedule)
  const scheduleExplicitlyCleared = Object.prototype.hasOwnProperty.call(sub, 'schedule') && sub.schedule === null
  const planSwitched = nextPlanId !== existing.planId
  const clearPending =
    (planSwitched && (nextPlanId === existing.pendingPlanId || !incomingScheduleId)) ||
    (eventType === 'customer.subscription.updated' && scheduleExplicitlyCleared) ||
    (nextCancelAtPeriodEnd && !incomingScheduleId)

  const nextPendingPlanId = clearPending ? null : existing.pendingPlanId
  const nextPendingEffectiveAt = clearPending ? null : existing.pendingEffectiveAt
  const nextStripeScheduleId = clearPending ? null : (incomingScheduleId ?? existing.stripeScheduleId)

  if (
    nextStatus === existing.status &&
    nextStart === existing.currentPeriodStart &&
    nextEnd === existing.currentPeriodEnd &&
    nextCancelAtPeriodEnd === existing.cancelAtPeriodEnd &&
    nextCustomerId === existing.stripeCustomerId &&
    nextPlanId === existing.planId &&
    nextPendingPlanId === existing.pendingPlanId &&
    nextPendingEffectiveAt === existing.pendingEffectiveAt &&
    nextStripeScheduleId === existing.stripeScheduleId
  ) {
    return c.json({ status: 'already_processed' })
  }

  await db
    .update(subscriptions)
    .set({
      stripeCustomerId: nextCustomerId,
      planId: nextPlanId,
      status: nextStatus,
      currentPeriodStart: nextStart,
      currentPeriodEnd: nextEnd,
      cancelAtPeriodEnd: nextCancelAtPeriodEnd,
      pendingPlanId: nextPendingPlanId,
      pendingEffectiveAt: nextPendingEffectiveAt,
      stripeScheduleId: nextStripeScheduleId,
    })
    .where(eq(subscriptions.id, existing.id))

  const statusOrCancelChanged =
    nextStatus !== existing.status || nextCancelAtPeriodEnd !== existing.cancelAtPeriodEnd || planSwitched
  if (eventType === 'customer.subscription.updated' || statusOrCancelChanged) {
    const logType =
      nextStatus === 'canceled' && existing.status !== 'canceled'
        ? 'canceled'
        : nextStatus === 'expired' && existing.status !== 'expired'
          ? 'expired'
          : 'updated'
    await db.insert(subscriptionEvents).values({
      id: newId('subscriptionEvent'),
      tenantId: tenant.id,
      subscriptionId: existing.id,
      type: logType,
      payload: {
        eventType,
        stripeSubscriptionId: sub.id,
        status: nextStatus,
        cancelAtPeriodEnd: nextCancelAtPeriodEnd,
        currentPeriodStart: nextStart,
        currentPeriodEnd: nextEnd,
        ...(planSwitched ? { fromPlanId: existing.planId, toPlanId: nextPlanId } : {}),
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

  const { currentPeriodStart, currentPeriodEnd: extractedEnd } = extractSubscriptionPeriod(sub)
  const cancelAtIso = toIsoSeconds(sub.cancel_at)
  const currentPeriodEnd = extractedEnd ?? cancelAtIso
  const cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end || cancelAtIso)
  const customerId = stripeId(sub.customer)

  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.stripeSubscriptionId, sub.id), eq(subscriptions.tenantId, tenant.id)))
  if (!existing) {
    await upsertPendingSubscription(db, tenant.id, sub.id, {
      stripeCustomerId: customerId,
      subscriptionStatus: 'expired',
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      eventCreated,
    })
    return c.json({ status: 'deferred' })
  }

  const nextCustomerId = existing.stripeCustomerId ?? customerId
  if (existing.status === 'expired' && nextCustomerId === existing.stripeCustomerId) {
    return c.json({ status: 'already_processed' })
  }

  await db
    .update(subscriptions)
    .set({
      stripeCustomerId: nextCustomerId,
      status: 'expired',
      currentPeriodStart: currentPeriodStart ?? existing.currentPeriodStart,
      currentPeriodEnd: currentPeriodEnd ?? existing.currentPeriodEnd,
      cancelAtPeriodEnd,
      pendingPlanId: null,
      pendingEffectiveAt: null,
      stripeScheduleId: null,
    })
    .where(eq(subscriptions.id, existing.id))

  if (existing.status !== 'expired') {
    await db.insert(subscriptionEvents).values({
      id: newId('subscriptionEvent'),
      tenantId: tenant.id,
      subscriptionId: existing.id,
      type: 'expired',
      payload: {
        stripeSubscriptionId: sub.id,
        endedAt: toIsoSeconds(sub.ended_at),
        currentPeriodEnd: currentPeriodEnd ?? existing.currentPeriodEnd,
      },
    })
  }
  return c.json({ status: 'processed' })
}

async function handleInvoicePaid(c: Context<AppEnv>, tenant: Tenant, invoice: StripeInvoice, eventCreated?: number) {
  const db = c.get('db')
  const subscriptionId = extractInvoiceSubscriptionId(invoice)
  if (!subscriptionId) return c.json({ status: 'ignored', reason: 'no subscription on invoice' })

  const { currentPeriodStart, currentPeriodEnd } = extractInvoicePeriod(invoice)
  const isInitialTrialInvoice = invoice.billing_reason === 'subscription_create' && (invoice.amount_paid ?? 0) === 0
  const customerId = stripeId(invoice.customer)

  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.stripeSubscriptionId, subscriptionId), eq(subscriptions.tenantId, tenant.id)))
  if (!existing) {
    await upsertPendingSubscription(db, tenant.id, subscriptionId, {
      stripeCustomerId: customerId,
      subscriptionStatus: 'active',
      currentPeriodStart,
      currentPeriodEnd,
      preserveTrialOnZeroInitialInvoice: isInitialTrialInvoice,
      eventCreated,
    })
    return c.json({ status: 'deferred' })
  }

  const nextStatus: SubscriptionStatus = isInitialTrialInvoice && existing.status === 'trialing' ? 'trialing' : 'active'
  const nextStart = currentPeriodStart ?? existing.currentPeriodStart
  const nextEnd = currentPeriodEnd ?? existing.currentPeriodEnd
  const nextCustomerId = existing.stripeCustomerId ?? customerId

  const unchanged =
    nextStatus === existing.status &&
    nextStart === existing.currentPeriodStart &&
    nextEnd === existing.currentPeriodEnd &&
    nextCustomerId === existing.stripeCustomerId

  const existingEvents = invoice.id
    ? await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.subscriptionId, existing.id))
    : []
  const alreadyLoggedInvoice = invoice.id
    ? existingEvents.some((e) => e.type === 'renewed' && e.payload['invoiceId'] === invoice.id)
    : false

  if (unchanged && (alreadyLoggedInvoice || invoice.billing_reason === 'subscription_create')) {
    return c.json({ status: 'already_processed' })
  }

  if (!unchanged) {
    await db
      .update(subscriptions)
      .set({
        stripeCustomerId: nextCustomerId,
        status: nextStatus,
        currentPeriodStart: nextStart,
        currentPeriodEnd: nextEnd,
      })
      .where(eq(subscriptions.id, existing.id))
  }

  if (invoice.billing_reason !== 'subscription_create' && !alreadyLoggedInvoice) {
    await db.insert(subscriptionEvents).values({
      id: newId('subscriptionEvent'),
      tenantId: tenant.id,
      subscriptionId: existing.id,
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

  const customerId = stripeId(invoice.customer)

  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.stripeSubscriptionId, subscriptionId), eq(subscriptions.tenantId, tenant.id)))
  if (!existing) {
    await upsertPendingSubscription(db, tenant.id, subscriptionId, {
      stripeCustomerId: customerId,
      subscriptionStatus: 'past_due',
      eventCreated,
    })
    return c.json({ status: 'deferred' })
  }

  if (existing.status === 'expired') {
    return c.json({ status: 'ignored', reason: 'subscription already expired' })
  }

  const nextCustomerId = existing.stripeCustomerId ?? customerId
  if (invoice.id) {
    const existingEvents = await db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.subscriptionId, existing.id))
    const alreadyLogged = existingEvents.some(
      (e) => e.type === 'payment_failed' && e.payload['invoiceId'] === invoice.id,
    )
    if (alreadyLogged && existing.status === 'past_due' && nextCustomerId === existing.stripeCustomerId) {
      return c.json({ status: 'already_processed' })
    }
  } else if (existing.status === 'past_due' && nextCustomerId === existing.stripeCustomerId) {
    return c.json({ status: 'already_processed' })
  }

  await db
    .update(subscriptions)
    .set({ stripeCustomerId: nextCustomerId, status: 'past_due' })
    .where(eq(subscriptions.id, existing.id))

  await db.insert(subscriptionEvents).values({
    id: newId('subscriptionEvent'),
    tenantId: tenant.id,
    subscriptionId: existing.id,
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

  const [license] = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.sourceRef, intentId), eq(licenses.tenantId, tenant.id)))
  if (!license) return c.json({ status: 'ignored', reason: 'unknown payment' })
  if (license.entitlementType !== 'perpetual') {
    return c.json({ status: 'ignored', reason: 'non-perpetual refund ignored' })
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
