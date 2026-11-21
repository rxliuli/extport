import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveStripePrice,
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  createStripePrice,
  createStripeProduct,
  StripeApiError,
} from '../src/lib/stripe-api'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('stripe-api REST client', () => {
  it('createStripeProduct sends form-urlencoded payload with Bearer auth', async () => {
    const calls: { url: string; auth: string | null; contentType: string | null; body: URLSearchParams }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(input),
        auth: headers.get('authorization'),
        contentType: headers.get('content-type'),
        body: new URLSearchParams(String(init?.body ?? '')),
      })
      return new Response(JSON.stringify({ id: 'prod_123' }), { status: 200 })
    }) as typeof fetch

    const res = await createStripeProduct('rk_test_secret', {
      name: 'My Extension (pro)',
      metadata: { extport_extension: 'ext_1', extport_plan: 'plan_1', extport_tier: 'pro' },
    })

    expect(res).toEqual({ id: 'prod_123' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/products')
    expect(calls[0]!.auth).toBe('Bearer rk_test_secret')
    expect(calls[0]!.contentType).toBe('application/x-www-form-urlencoded')
    expect(calls[0]!.body.get('name')).toBe('My Extension (pro)')
    expect(calls[0]!.body.get('metadata[extport_extension]')).toBe('ext_1')
    expect(calls[0]!.body.get('metadata[extport_plan]')).toBe('plan_1')
    expect(calls[0]!.body.get('metadata[extport_tier]')).toBe('pro')
  })

  it('createStripePrice and archiveStripePrice format recurring and archive requests', async () => {
    const calls: { url: string; body: URLSearchParams }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? '')) })
      return new Response(JSON.stringify({ id: 'price_abc' }), { status: 200 })
    }) as typeof fetch

    const price = await createStripePrice('rk_test_1', {
      productId: 'prod_123',
      unitAmount: 499,
      currency: 'USD',
      interval: 'month',
      nickname: 'pro (monthly)',
      metadata: { extport_plan: 'plan_1' },
    })
    expect(price).toEqual({ id: 'price_abc' })
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/prices')
    expect(calls[0]!.body.get('product')).toBe('prod_123')
    expect(calls[0]!.body.get('unit_amount')).toBe('499')
    expect(calls[0]!.body.get('currency')).toBe('usd')
    expect(calls[0]!.body.get('recurring[interval]')).toBe('month')
    expect(calls[0]!.body.get('nickname')).toBe('pro (monthly)')
    expect(calls[0]!.body.get('metadata[extport_plan]')).toBe('plan_1')

    await archiveStripePrice('rk_test_1', 'price_old')
    expect(calls[1]!.url).toBe('https://api.stripe.com/v1/prices/price_old')
    expect(calls[1]!.body.get('active')).toBe('false')
  })

  it('createStripeCheckoutSession prefers customer over customer_email and sets subscription_data metadata only in subscription mode', async () => {
    const calls: URLSearchParams[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new URLSearchParams(String(init?.body ?? '')))
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }), {
        status: 200,
      })
    }) as typeof fetch

    // Payment mode with customerEmail (no customerId).
    const paymentSession = await createStripeCheckoutSession('rk_test_1', {
      mode: 'payment',
      priceId: 'price_once',
      planId: 'plan_once',
      customerEmail: 'buyer@example.com',
      externalUserId: 'usr_1',
      successUrl: 'https://portal.extport.dev/purchase/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://example.com/cancel',
    })
    expect(paymentSession).toEqual({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' })
    expect(calls[0]!.get('mode')).toBe('payment')
    expect(calls[0]!.get('line_items[0][price]')).toBe('price_once')
    expect(calls[0]!.get('line_items[0][quantity]')).toBe('1')
    expect(calls[0]!.get('metadata[extport_plan]')).toBe('plan_once')
    expect(calls[0]!.get('allow_promotion_codes')).toBe('true')
    expect(calls[0]!.get('client_reference_id')).toBe('usr_1')
    expect(calls[0]!.get('customer')).toBeNull()
    expect(calls[0]!.get('customer_email')).toBe('buyer@example.com')
    expect(calls[0]!.get('subscription_data[metadata][extport_plan]')).toBeNull()

    // Subscription mode with customerId: must NOT also set customer_email.
    await createStripeCheckoutSession('rk_test_1', {
      mode: 'subscription',
      priceId: 'price_mo',
      planId: 'plan_sub',
      customerId: 'cus_existing',
      customerEmail: 'buyer@example.com',
      externalUserId: 'usr_1',
      successUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel',
    })
    expect(calls[1]!.get('mode')).toBe('subscription')
    expect(calls[1]!.get('customer')).toBe('cus_existing')
    expect(calls[1]!.get('customer_email')).toBeNull()
    expect(calls[1]!.get('subscription_data[metadata][extport_plan]')).toBe('plan_sub')
  })

  it('createStripeBillingPortalSession sends customer and return_url', async () => {
    const calls: { url: string; body: URLSearchParams }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? '')) })
      return new Response(JSON.stringify({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' }), {
        status: 200,
      })
    }) as typeof fetch

    const portal = await createStripeBillingPortalSession('rk_test_1', {
      customerId: 'cus_123',
      returnUrl: 'https://portal.extport.dev/portal',
    })
    expect(portal).toEqual({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' })
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions')
    expect(calls[0]!.body.get('customer')).toBe('cus_123')
    expect(calls[0]!.body.get('return_url')).toBe('https://portal.extport.dev/portal')
  })

  it('throws typed StripeApiError on Stripe errors and network failures without leaking API key', async () => {
    const apiKey = 'rk_test_supersecret_999'
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'resource_missing',
            type: 'invalid_request_error',
            message: 'No such price: price_bad',
          },
        }),
        { status: 404 },
      )) as typeof fetch

    let caught: unknown
    try {
      await createStripeCheckoutSession(apiKey, {
        mode: 'payment',
        priceId: 'price_bad',
        planId: 'plan_1',
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/cancel',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(StripeApiError)
    expect((caught as StripeApiError).status).toBe(404)
    expect((caught as StripeApiError).code).toBe('resource_missing')
    expect((caught as StripeApiError).message).toBe('No such price: price_bad')
    expect((caught as StripeApiError).message).not.toContain(apiKey)

    globalThis.fetch = (async () => {
      throw new Error('connect ETIMEDOUT')
    }) as typeof fetch

    await expect(createStripeProduct(apiKey, { name: 'Ext' })).rejects.toMatchObject({
      name: 'StripeApiError',
      status: 502,
      code: 'network_error',
    })
  })
})
