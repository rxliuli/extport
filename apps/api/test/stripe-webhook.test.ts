import { eq } from 'drizzle-orm'
import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { licenseEvents, licenses, pendingStripeSubscriptions, type License, type Plan } from '../src/db'
import { createApiKey, createExtension, request, seedTenantWithUser } from './helpers'

const SECRET = 'whsec_testsecret123'
const KEY_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/

async function stripeSignature(body: string, opts: { secret?: string; timestamp?: number } = {}): Promise<string> {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(opts.secret ?? SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${timestamp},v1=${hex}`
}

async function deliver(
  tenantId: string,
  event: unknown,
  opts: { secret?: string; timestamp?: number; signature?: string | null } = {},
): Promise<Response> {
  const body = JSON.stringify(event)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.signature !== null) {
    headers['stripe-signature'] = opts.signature ?? (await stripeSignature(body, opts))
  }
  return request(`/api/v1/licensing/webhooks/stripe/${tenantId}`, { method: 'POST', headers, body })
}

// sourceRef has a globally unique index, so every test needs its own ids —
// a fixed 'pi_test_1' would collide across tests sharing this file's DB.
let refSeq = 0
const nextRef = (prefix: string) => `${prefix}_${++refSeq}`

function checkoutEvent(planId: string, sessionOverrides: Record<string, unknown> = {}) {
  return {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: nextRef('cs'),
        payment_status: 'paid',
        payment_intent: nextRef('pi'),
        amount_total: 1999,
        currency: 'usd',
        customer_details: { email: 'buyer@example.com' },
        metadata: { extport_plan: planId },
        ...sessionOverrides,
      },
    },
  }
}

async function setupStripeTenant(opts: { entitlementType?: 'perpetual' | 'recurring' } = {}) {
  const seeded = await seedTenantWithUser()
  const { sessionCookie } = seeded
  const extension = await createExtension(sessionCookie)
  await request(`/api/v1/extensions/${extension.id}`, {
    method: 'PATCH',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ licensingEnabled: true }),
  })
  const productRes = await request('/api/v1/plans', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      extensionId: extension.id,
      tier: 'pro',
      ...(opts.entitlementType ? { entitlementType: opts.entitlementType } : {}),
    }),
  })
  const { plan } = (await productRes.json()) as { plan: Plan }
  const credRes = await request('/api/v1/payment-credentials', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'stripe', webhookSecret: SECRET }),
  })
  expect(credRes.status).toBe(200)
  return { ...seeded, extension, plan }
}

async function tenantLicenses(
  db: Awaited<ReturnType<typeof seedTenantWithUser>>['db'],
  tenantId: string,
): Promise<License[]> {
  return db.select().from(licenses).where(eq(licenses.tenantId, tenantId))
}

describe('payment credentials API', () => {
  it('stores the secret write-only (hint exposed, secret never returned)', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    const res = await request('/api/v1/payment-credentials', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'stripe', webhookSecret: SECRET }),
    })
    expect(res.status).toBe(200)
    const stored = JSON.stringify(await res.json())
    expect(stored).not.toContain(SECRET)
    expect(stored).toContain(SECRET.slice(-4))

    const listed = await request('/api/v1/payment-credentials', { headers: { cookie: sessionCookie } })
    const body = (await listed.json()) as { credentials: { provider: string; hint: string }[] }
    expect(body.credentials).toHaveLength(1)
    expect(body.credentials[0]!.hint).toBe(SECRET.slice(-4))
  })

  it('upserts per (tenant, provider) and requires a dashboard session', async () => {
    const { sessionCookie } = await seedTenantWithUser()
    for (const secret of ['whsec_first111', 'whsec_second222']) {
      await request('/api/v1/payment-credentials', {
        method: 'POST',
        headers: { cookie: sessionCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'stripe', webhookSecret: secret }),
      })
    }
    const listed = await request('/api/v1/payment-credentials', { headers: { cookie: sessionCookie } })
    const body = (await listed.json()) as { credentials: { hint: string }[] }
    expect(body.credentials).toHaveLength(1)
    expect(body.credentials[0]!.hint).toBe('d222')

    expect((await request('/api/v1/payment-credentials')).status).toBe(401)
    // API keys are locked out, same rule as store credentials.
    const apiKey = await createApiKey(sessionCookie)
    const viaKey = await request('/api/v1/payment-credentials', { headers: { authorization: `Bearer ${apiKey}` } })
    expect(viaKey.status).toBe(401)
  })
})

describe('POST /v1/licensing/webhooks/stripe/:tenantId — signature gate', () => {
  it('rejects a missing, malformed, wrong-secret, or stale signature', async () => {
    const { tenantId, plan } = await setupStripeTenant()
    const event = checkoutEvent(plan.id)

    expect((await deliver(tenantId, event, { signature: null })).status).toBe(400)
    expect((await deliver(tenantId, event, { signature: 'garbage' })).status).toBe(400)
    expect((await deliver(tenantId, event, { secret: 'whsec_wrongsecret' })).status).toBe(400)
    const stale = Math.floor(Date.now() / 1000) - 400
    expect((await deliver(tenantId, event, { timestamp: stale })).status).toBe(400)
  })

  it('404s for an unknown tenant or one without a stripe credential', async () => {
    const bare = await seedTenantWithUser()
    expect((await deliver('ten_doesnotexist', {})).status).toBe(404)
    expect((await deliver(bare.tenantId, {})).status).toBe(404)
  })
})

describe('checkout.session.completed fulfillment', () => {
  it('issues a license the public endpoint can immediately activate', async () => {
    const { db, tenantId, extension, plan } = await setupStripeTenant()
    const event = checkoutEvent(plan.id)
    const res = await deliver(tenantId, event)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { status: string }).status).toBe('processed')

    const rows = await tenantLicenses(db, tenantId)
    expect(rows).toHaveLength(1)
    const license = rows[0]!
    expect(license.key).toMatch(KEY_RE)
    expect(license.source).toBe('stripe_webhook')
    expect(license.sourceRef).toBe((event.data.object as { payment_intent: string }).payment_intent)
    expect(license.checkoutSessionId).toBe((event.data.object as { id: string }).id)
    expect(license.buyerEmail).toBe('buyer@example.com')
    expect(license.maxActivations).toBe(plan.maxActivations)
    // The sale amount snapshot — the basis for future percentage billing.
    expect(license.amountTotal).toBe(1999)
    expect(license.currency).toBe('usd')
    // No address on this session (the common case under billing_address_collection:
    // 'auto') — country stays null, not an error.
    expect(license.country).toBeNull()

    const events = await db.select().from(licenseEvents).where(eq(licenseEvents.licenseId, license.id))
    expect(events.map((e) => e.type)).toEqual(['issued'])

    // Full circle: the emailed code works against the public wire protocol.
    const activateRes = await request('/api/v1/licensing/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: license.key, extensionId: extension.id, fingerprint: 'fp-buyer' }),
    })
    const activated = (await activateRes.json()) as { success: boolean; data?: { tier: string } }
    expect(activated.success).toBe(true)
    expect(activated.data?.tier).toBe('pro')
  })

  it('is idempotent across Stripe redeliveries', async () => {
    const { db, tenantId, plan } = await setupStripeTenant()
    const event = checkoutEvent(plan.id)
    await deliver(tenantId, event)
    const replay = await deliver(tenantId, event)
    expect(((await replay.json()) as { status: string }).status).toBe('already_processed')
    expect(await tenantLicenses(db, tenantId)).toHaveLength(1)
  })

  it('falls back to the session id for zero-total sessions without a PaymentIntent', async () => {
    const { db, tenantId, plan } = await setupStripeTenant()
    const event = checkoutEvent(plan.id, { payment_intent: null, payment_status: 'no_payment_required' })
    await deliver(tenantId, event)
    const [license] = await tenantLicenses(db, tenantId)
    expect(license!.sourceRef).toBe((event.data.object as { id: string }).id)
  })

  it('stores the billing country when the session collected one', async () => {
    const { db, tenantId, plan } = await setupStripeTenant()
    const event = checkoutEvent(plan.id, {
      customer_details: { email: 'buyer@example.com', address: { country: 'TH' } },
    })
    await deliver(tenantId, event)
    const [license] = await tenantLicenses(db, tenantId)
    expect(license!.country).toBe('TH')
  })

  it('ignores sessions that are not extport sales or not paid', async () => {
    const { db, tenantId, plan } = await setupStripeTenant()

    const foreign = await deliver(tenantId, checkoutEvent(plan.id, { metadata: {} }))
    expect(((await foreign.json()) as { status: string }).status).toBe('ignored')

    const unpaid = await deliver(tenantId, checkoutEvent(plan.id, { payment_status: 'unpaid' }))
    expect(((await unpaid.json()) as { status: string }).status).toBe('ignored')

    expect(await tenantLicenses(db, tenantId)).toHaveLength(0)
  })

  it('fails loudly (5xx → Stripe retries/surfaces) when extport_plan does not resolve', async () => {
    const { db, tenantId } = await setupStripeTenant()
    const other = await setupStripeTenant()

    expect((await deliver(tenantId, checkoutEvent('prod_doesnotexist'))).status).toBe(500)
    // Another tenant's plan id must not cross the tenant boundary.
    expect((await deliver(tenantId, checkoutEvent(other.plan.id))).status).toBe(500)
    expect(await tenantLicenses(db, tenantId)).toHaveLength(0)
  })
})

describe('charge.refunded / charge.dispute.created revocation', () => {
  it('flips the license to refunded, after which activation is rejected', async () => {
    const { db, tenantId, extension, plan } = await setupStripeTenant()
    const event = checkoutEvent(plan.id)
    await deliver(tenantId, event)
    const [license] = await tenantLicenses(db, tenantId)

    const res = await deliver(tenantId, {
      type: 'charge.refunded',
      data: { object: { payment_intent: (event.data.object as { payment_intent: string }).payment_intent } },
    })
    expect(((await res.json()) as { status: string }).status).toBe('processed')

    const [after] = await db.select().from(licenses).where(eq(licenses.id, license!.id))
    expect(after!.status).toBe('refunded')
    const events = await db.select().from(licenseEvents).where(eq(licenseEvents.licenseId, license!.id))
    expect(events.map((e) => e.type)).toEqual(['issued', 'revoked'])

    const activateRes = await request('/api/v1/licensing/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: license!.key, extensionId: extension.id, fingerprint: 'fp-refunded' }),
    })
    expect(((await activateRes.json()) as { success: boolean }).success).toBe(false)
  })

  it('replays and unknown payments are clean no-ops', async () => {
    const { db, tenantId, plan } = await setupStripeTenant()
    const event = checkoutEvent(plan.id)
    await deliver(tenantId, event)
    const refund = {
      type: 'charge.refunded',
      data: { object: { payment_intent: (event.data.object as { payment_intent: string }).payment_intent } },
    }
    await deliver(tenantId, refund)
    const replay = await deliver(tenantId, refund)
    expect(((await replay.json()) as { status: string }).status).toBe('already_processed')

    const unknown = await deliver(tenantId, {
      type: 'charge.dispute.created',
      data: { object: { payment_intent: 'pi_other' } },
    })
    expect(((await unknown.json()) as { status: string }).status).toBe('ignored')

    const events = await db.select().from(licenseEvents).where(eq(licenseEvents.tenantId, tenantId))
    expect(events.filter((e) => e.type === 'revoked')).toHaveLength(1)
  })

  it('ignores unrelated event types', async () => {
    const { tenantId } = await setupStripeTenant()
    const res = await deliver(tenantId, { type: 'invoice.paid', data: { object: {} } })
    expect(((await res.json()) as { status: string }).status).toBe('ignored')
  })
})

describe('recurring subscription webhooks', () => {
  const nowSec = () => Math.floor(Date.now() / 1000)

  it('fulfills subscription checkout with client_reference_id, syncs 2025-03-31+ item periods, renewals, and emails portal URL', async () => {
    const { db, tenantId, sessionCookie, extension, plan } = await setupStripeTenant({
      entitlementType: 'recurring',
    })
    await request('/api/v1/tenant/settings', {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ billingPortalUrl: 'https://billing.stripe.com/p/login/sub_portal' }),
    })

    const sendSpy = vi.spyOn(env.EMAIL, 'send').mockResolvedValue({ messageId: 'm1' } as never)

    const subId = nextRef('sub')
    const p1Start = nowSec()
    const p1End = p1Start + 30 * 86400
    const checkout = checkoutEvent(plan.id, {
      mode: 'subscription',
      payment_status: 'paid',
      payment_intent: null,
      subscription: subId,
      client_reference_id: 'tw_user_42',
      amount_total: 900,
    })
    expect((await deliver(tenantId, checkout)).status).toBe(200)

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'buyer@example.com',
        text: expect.stringContaining('https://billing.stripe.com/p/login/sub_portal'),
      }),
    )
    sendSpy.mockRestore()

    let [license] = await tenantLicenses(db, tenantId)
    expect(license!.entitlementType).toBe('recurring')
    expect(license!.stripeSubscriptionId).toBe(subId)
    expect(license!.externalUserId).toBe('tw_user_42')
    expect(license!.sourceRef).toBe(subId)
    expect(license!.subscriptionStatus).toBe('active')

    // Deliver Stripe API 2025-03-31+ subscription payload (period on items.data[0], no top-level period).
    const subCreated = await deliver(tenantId, {
      type: 'customer.subscription.created',
      created: p1Start,
      data: {
        object: {
          id: subId,
          status: 'active',
          cancel_at_period_end: false,
          items: { data: [{ current_period_start: p1Start, current_period_end: p1End }] },
        },
      },
    })
    expect(subCreated.status).toBe(200)

    ;[license] = await tenantLicenses(db, tenantId)
    expect(license!.currentPeriodStart).toBe(new Date(p1Start * 1000).toISOString())
    expect(license!.currentPeriodEnd).toBe(new Date(p1End * 1000).toISOString())

    // Activate via public protocol and verify real expiresAt + subscription metadata.
    const actRes = await request('/api/v1/licensing/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: license!.key, extensionId: extension.id, fingerprint: 'fp-sub-1' }),
    })
    const actBody = (await actRes.json()) as {
      success: boolean
      data: { tier: string; expiresAt: string; subscriptionStatus: string; cancelAtPeriodEnd: boolean }
    }
    expect(actBody.success).toBe(true)
    expect(actBody.data).toEqual({
      tier: 'pro',
      expiresAt: new Date(p1End * 1000).toISOString(),
      subscriptionStatus: 'active',
      cancelAtPeriodEnd: false,
    })

    // Renewal invoice.paid using 2025-03-31+ parent.subscription_details.subscription shape.
    const p2Start = p1End
    const p2End = p2Start + 30 * 86400
    const invoicePayload = {
      type: 'invoice.paid',
      created: p2Start,
      data: {
        object: {
          id: nextRef('in'),
          billing_reason: 'subscription_cycle',
          amount_paid: 900,
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: subId },
          },
          lines: {
            data: [{ type: 'subscription', period: { start: p2Start, end: p2End } }],
          },
        },
      },
    }
    expect((await deliver(tenantId, invoicePayload)).status).toBe(200)
    // Duplicate invoice.paid delivery should be idempotent.
    const replay = await deliver(tenantId, invoicePayload)
    expect(((await replay.json()) as { status: string }).status).toBe('already_processed')

    ;[license] = await tenantLicenses(db, tenantId)
    expect(license!.currentPeriodEnd).toBe(new Date(p2End * 1000).toISOString())
    const events = await db.select().from(licenseEvents).where(eq(licenseEvents.licenseId, license!.id))
    expect(events.filter((e) => e.type === 'renewed')).toHaveLength(1)
  })

  it('handles out-of-order subscription & invoice events arriving before checkout.session.completed', async () => {
    const { db, tenantId, plan } = await setupStripeTenant({ entitlementType: 'recurring' })
    const subId = nextRef('sub')
    const start = nowSec()
    const trialEnd = start + 7 * 86400

    // 1. customer.subscription.created arrives FIRST (trialing, legacy top-level period fields).
    const r1 = await deliver(tenantId, {
      type: 'customer.subscription.created',
      created: start,
      data: {
        object: {
          id: subId,
          status: 'trialing',
          current_period_start: start,
          current_period_end: trialEnd,
          cancel_at_period_end: false,
          metadata: { extport_plan: plan.id },
        },
      },
    })
    expect(((await r1.json()) as { status: string }).status).toBe('deferred')

    // 2. Initial $0 trial invoice.paid arrives SECOND (must preserve 'trialing').
    const r2 = await deliver(tenantId, {
      type: 'invoice.paid',
      created: start,
      data: {
        object: {
          id: nextRef('in'),
          subscription: subId,
          billing_reason: 'subscription_create',
          amount_paid: 0,
          lines: { data: [{ period: { start, end: trialEnd } }] },
        },
      },
    })
    expect(((await r2.json()) as { status: string }).status).toBe('deferred')

    // 3. checkout.session.completed arrives LAST with no_payment_required + client_reference_id.
    const r3 = await deliver(
      tenantId,
      checkoutEvent(plan.id, {
        mode: 'subscription',
        payment_status: 'no_payment_required',
        payment_intent: null,
        amount_total: 0,
        subscription: subId,
        client_reference_id: 'trial_user_1',
      }),
    )
    expect(((await r3.json()) as { status: string }).status).toBe('processed')

    const [license] = await tenantLicenses(db, tenantId)
    expect(license!.subscriptionStatus).toBe('trialing')
    expect(license!.externalUserId).toBe('trial_user_1')
    expect(license!.currentPeriodStart).toBe(new Date(start * 1000).toISOString())
    expect(license!.currentPeriodEnd).toBe(new Date(trialEnd * 1000).toISOString())
    expect(await db.select().from(pendingStripeSubscriptions)).toHaveLength(0)

    // Out-of-order transient 'incomplete' subscription.created arriving later must not downgrade.
    const staleCreate = await deliver(tenantId, {
      type: 'customer.subscription.created',
      created: start,
      data: { object: { id: subId, status: 'incomplete' } },
    })
    expect(((await staleCreate.json()) as { status: string }).status).toBe('ignored')
    const [after] = await tenantLicenses(db, tenantId)
    expect(after!.subscriptionStatus).toBe('trialing')
  })

  it('tracks payment_failed (past_due), cancel_at_period_end, and immediate deletion (expired)', async () => {
    const { db, tenantId, extension, plan } = await setupStripeTenant({ entitlementType: 'recurring' })
    const subId = nextRef('sub')
    const start = nowSec()
    const end = start + 30 * 86400

    await deliver(
      tenantId,
      checkoutEvent(plan.id, {
        mode: 'subscription',
        payment_status: 'paid',
        payment_intent: null,
        subscription: subId,
      }),
    )
    await deliver(tenantId, {
      type: 'customer.subscription.updated',
      created: start,
      data: {
        object: {
          id: subId,
          status: 'active',
          cancel_at_period_end: false,
          items: { data: [{ current_period_start: start, current_period_end: end }] },
        },
      },
    })

    const [license] = await tenantLicenses(db, tenantId)
    await request('/api/v1/licensing/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: license!.key, extensionId: extension.id, fingerprint: 'fp-sub-life' }),
    })

    // Payment failure -> past_due (still entitled during Stripe retry grace period).
    await deliver(tenantId, {
      type: 'invoice.payment_failed',
      created: start + 100,
      data: {
        object: {
          id: nextRef('in'),
          attempt_count: 1,
          parent: { subscription_details: { subscription: subId } },
        },
      },
    })
    let [current] = await tenantLicenses(db, tenantId)
    expect(current!.subscriptionStatus).toBe('past_due')
    const checkPastDue = (await (
      await request('/api/v1/licensing/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: license!.key, extensionId: extension.id, fingerprint: 'fp-sub-life' }),
      })
    ).json()) as { data: { isActive: boolean; subscriptionStatus: string } }
    expect(checkPastDue.data.isActive).toBe(true)
    expect(checkPastDue.data.subscriptionStatus).toBe('past_due')

    // Recovered payment -> active; then cancel at period end -> active + cancelAtPeriodEnd: true.
    await deliver(tenantId, {
      type: 'customer.subscription.updated',
      created: start + 200,
      data: {
        object: {
          id: subId,
          status: 'active',
          cancel_at_period_end: true,
          items: { data: [{ current_period_start: start, current_period_end: end }] },
        },
      },
    })
    ;[current] = await tenantLicenses(db, tenantId)
    expect(current!.subscriptionStatus).toBe('active')
    expect(current!.cancelAtPeriodEnd).toBe(true)

    // Immediate deletion (even with current_period_end still in the future) -> expired & immediately inactive.
    await deliver(tenantId, {
      type: 'customer.subscription.deleted',
      created: start + 300,
      data: {
        object: {
          id: subId,
          status: 'canceled',
          cancel_at_period_end: false,
          ended_at: start + 300,
          items: { data: [{ current_period_start: start, current_period_end: end }] },
        },
      },
    })
    ;[current] = await tenantLicenses(db, tenantId)
    expect(current!.subscriptionStatus).toBe('expired')

    const checkDeleted = (await (
      await request('/api/v1/licensing/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: license!.key, extensionId: extension.id, fingerprint: 'fp-sub-life' }),
      })
    ).json()) as { data: { isActive: boolean; subscriptionStatus: string } }
    expect(checkDeleted.data.isActive).toBe(false)
    expect(checkDeleted.data.subscriptionStatus).toBe('expired')

    // Partial/single-invoice charge.refunded never destroys a recurring license via sourceRef lookup.
    const refundAttempt = await deliver(tenantId, {
      type: 'charge.refunded',
      data: { object: { payment_intent: subId } },
    })
    expect(((await refundAttempt.json()) as { status: string }).status).toBe('ignored')
  })

  it('fails loudly (5xx) when checkout mode mismatches the plan entitlementType', async () => {
    const perpetual = await setupStripeTenant({ entitlementType: 'perpetual' })
    const recurring = await setupStripeTenant({ entitlementType: 'recurring' })

    // Subscription checkout pointed at a perpetual plan must not silently issue a forever-active license.
    const subOnPerpetual = await deliver(
      perpetual.tenantId,
      checkoutEvent(perpetual.plan.id, {
        mode: 'subscription',
        payment_intent: null,
        subscription: nextRef('sub'),
      }),
    )
    expect(subOnPerpetual.status).toBe(500)
    expect(await tenantLicenses(perpetual.db, perpetual.tenantId)).toHaveLength(0)

    // One-time payment checkout pointed at a recurring plan must also fail loudly.
    const paymentOnRecurring = await deliver(
      recurring.tenantId,
      checkoutEvent(recurring.plan.id, {
        mode: 'payment',
        subscription: null,
      }),
    )
    expect(paymentOnRecurring.status).toBe(500)
    expect(await tenantLicenses(recurring.db, recurring.tenantId)).toHaveLength(0)
  })
})
