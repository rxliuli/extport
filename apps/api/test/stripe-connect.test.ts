import { createExecutionContext, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { paymentCredentials, subscriptions, type Plan } from '../src/db'
import { app } from '../src/index'
import { createExtension, seedTenantWithUser } from './helpers'

const CONNECT_CLIENT_ID = 'ca_test_extport'
const PLATFORM_SECRET_KEY = 'sk_test_platform_secret'
const CONNECT_WEBHOOK_SECRET = 'whsec_connect_platform_secret'

const connectEnv: Env = {
  ...env,
  STRIPE_CONNECT_CLIENT_ID: CONNECT_CLIENT_ID,
  STRIPE_SECRET_KEY: PLATFORM_SECRET_KEY,
  STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_WEBHOOK_SECRET,
}

function connectRequest(path: string, init?: RequestInit, customEnv: Env = connectEnv): Promise<Response> {
  return Promise.resolve(app.request(path, init, customEnv, createExecutionContext()))
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

async function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${timestamp},v1=${hex}`
}

function extractCookie(res: Response, name: string): string | null {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? '']
  for (const raw of setCookies) {
    const first = raw.split(';')[0]?.trim()
    if (first?.startsWith(`${name}=`)) return first
  }
  return null
}

describe('Stripe Connect Standard OAuth2', () => {
  it('reports connectEnabled based on platform env vars and completes full OAuth connect -> API -> webhook -> disconnect lifecycle', async () => {
    const { db, tenantId, sessionCookie } = await seedTenantWithUser()

    // Without platform vars -> connectEnabled is false and /stripe/connect returns 503.
    const unconfiguredEnv: Env = { ...env, STRIPE_CONNECT_CLIENT_ID: '', STRIPE_SECRET_KEY: '' }
    const unconfiguredRes = await connectRequest(
      '/api/v1/payment-credentials',
      { headers: { cookie: sessionCookie } },
      unconfiguredEnv,
    )
    expect(unconfiguredRes.status).toBe(200)
    expect(await unconfiguredRes.json()).toEqual({ credentials: [], connectEnabled: false })
    expect(
      (
        await connectRequest(
          '/api/v1/payment-credentials/stripe/connect',
          { headers: { cookie: sessionCookie } },
          unconfiguredEnv,
        )
      ).status,
    ).toBe(503)

    // With platform vars -> connectEnabled is true.
    const configuredRes = await connectRequest('/api/v1/payment-credentials', { headers: { cookie: sessionCookie } })
    expect(configuredRes.status).toBe(200)
    expect(await configuredRes.json()).toEqual({ credentials: [], connectEnabled: true })

    // Step 1: Start OAuth -> redirects to Stripe Connect authorize URL with CSRF state cookie.
    const startRes = await connectRequest('/api/v1/payment-credentials/stripe/connect', {
      headers: { cookie: sessionCookie },
    })
    expect(startRes.status).toBe(302)
    const location = new URL(startRes.headers.get('location')!)
    expect(location.origin).toBe('https://connect.stripe.com')
    expect(location.pathname).toBe('/oauth/authorize')
    expect(location.searchParams.get('client_id')).toBe(CONNECT_CLIENT_ID)
    expect(location.searchParams.get('scope')).toBe('read_write')
    const state = location.searchParams.get('state')!
    expect(state.length).toBeGreaterThan(10)
    const stateCookie = extractCookie(startRes, 'extport_stripe_oauth_state')!
    expect(stateCookie).toBeTruthy()

    // Invalid state -> redirects back to Settings with stripe_error=invalid_state.
    const badStateRes = await connectRequest(
      `/api/v1/payment-credentials/stripe/callback?code=ac_bad&state=wrong`,
      { headers: { cookie: `${sessionCookie}; ${stateCookie}` } },
    )
    expect(badStateRes.status).toBe(302)
    expect(badStateRes.headers.get('location')).toContain('stripe_error=invalid_state')

    // Cancelled -> redirects with stripe_error=cancelled.
    const cancelRes = await connectRequest(
      `/api/v1/payment-credentials/stripe/callback?error=access_denied`,
      { headers: { cookie: `${sessionCookie}; ${stateCookie}` } },
    )
    expect(cancelRes.status).toBe(302)
    expect(cancelRes.headers.get('location')).toContain('stripe_error=cancelled')

    // Mock Stripe OAuth + Stripe API calls and record headers.
    const recordedCalls: Array<{ url: string; auth: string | null; stripeAccount: string | null; body: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const bodyText = typeof init?.body === 'string' ? init.body : ''
      recordedCalls.push({
        url,
        auth: headers.get('authorization'),
        stripeAccount: headers.get('stripe-account'),
        body: bodyText,
      })

      if (url === 'https://connect.stripe.com/oauth/token') {
        return new Response(
          JSON.stringify({ stripe_user_id: 'acct_connected_1', livemode: false, scope: 'read_write' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'https://connect.stripe.com/oauth/deauthorize') {
        return new Response(JSON.stringify({ stripe_user_id: 'acct_connected_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === 'https://api.stripe.com/v1/products') {
        return new Response(JSON.stringify({ id: 'prod_connect_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === 'https://api.stripe.com/v1/prices') {
        return new Response(JSON.stringify({ id: 'price_connect_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === 'https://api.stripe.com/v1/checkout/sessions') {
        return new Response(JSON.stringify({ id: 'cs_connect_1', url: 'https://checkout.stripe.com/c/pay/cs_connect_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    // Step 2: Complete OAuth callback -> binds acct_connected_1.
    const cbRes = await connectRequest(
      `/api/v1/payment-credentials/stripe/callback?code=ac_valid_1&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${sessionCookie}; ${stateCookie}` } },
    )
    expect(cbRes.status).toBe(302)
    expect(cbRes.headers.get('location')).toContain('stripe=connected')
    expect(recordedCalls[0]?.url).toBe('https://connect.stripe.com/oauth/token')
    expect(recordedCalls[0]?.auth).toBe(`Bearer ${PLATFORM_SECRET_KEY}`)

    // Another tenant cannot connect the same acct_connected_1.
    const other = await seedTenantWithUser()
    const otherStart = await connectRequest('/api/v1/payment-credentials/stripe/connect', {
      headers: { cookie: other.sessionCookie },
    })
    const otherState = new URL(otherStart.headers.get('location')!).searchParams.get('state')!
    const otherCookie = extractCookie(otherStart, 'extport_stripe_oauth_state')!
    const conflictRes = await connectRequest(
      `/api/v1/payment-credentials/stripe/callback?code=ac_dupe&state=${encodeURIComponent(otherState)}`,
      { headers: { cookie: `${other.sessionCookie}; ${otherCookie}` } },
    )
    expect(conflictRes.status).toBe(302)
    expect(conflictRes.headers.get('location')).toContain('stripe_error=account_in_use')

    // Step 3: Create a subscription plan -> sends Platform key + Stripe-Account: acct_connected_1.
    const ext = await createExtension(sessionCookie, 'Connect Sub Ext')
    await connectRequest(`/api/v1/extensions/${ext.id}`, {
      method: 'PATCH',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ licensingEnabled: true, billingMode: 'subscription' }),
    })
    const planRes = await connectRequest('/api/v1/plans', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        extensionId: ext.id,
        tier: 'pro',
        entitlementType: 'recurring',
        billingInterval: 'month',
        amount: 499,
      }),
    })
    expect(planRes.status).toBe(201)
    const { plan } = (await planRes.json()) as { plan: Plan }
    expect(plan.stripeProductId).toBe('prod_connect_1')
    expect(plan.stripePriceId).toBe('price_connect_1')

    const productCall = recordedCalls.find((c) => c.url === 'https://api.stripe.com/v1/products')!
    const priceCall = recordedCalls.find((c) => c.url === 'https://api.stripe.com/v1/prices')!
    expect(productCall.auth).toBe(`Bearer ${PLATFORM_SECRET_KEY}`)
    expect(productCall.stripeAccount).toBe('acct_connected_1')
    expect(priceCall.auth).toBe(`Bearer ${PLATFORM_SECRET_KEY}`)
    expect(priceCall.stripeAccount).toBe('acct_connected_1')

    // Hosted checkout redirect also uses Stripe-Account header.
    const buyRes = await connectRequest(`/api/v1/portal/buy/${plan.id}`)
    expect(buyRes.status).toBe(303)
    const checkoutCall = recordedCalls.find((c) => c.url === 'https://api.stripe.com/v1/checkout/sessions')!
    expect(checkoutCall.stripeAccount).toBe('acct_connected_1')

    // Step 4: Platform Connect Webhook routes by event.account to the connected tenant.
    const webhookBody = JSON.stringify({
      type: 'checkout.session.completed',
      account: 'acct_connected_1',
      data: {
        object: {
          id: 'cs_connect_1',
          mode: 'subscription',
          payment_status: 'paid',
          customer: 'cus_connect_1',
          subscription: 'sub_connect_1',
          customer_details: { email: 'connect-buyer@example.com' },
          metadata: { extport_plan: plan.id },
          amount_total: 499,
          currency: 'usd',
        },
      },
    })
    const badSigRes = await connectRequest('/api/v1/licensing/webhooks/stripe/connect', {
      method: 'POST',
      headers: { 'stripe-signature': 't=123,v1=deadbeef' },
      body: webhookBody,
    })
    expect(badSigRes.status).toBe(400)

    const goodSig = await signWebhook(CONNECT_WEBHOOK_SECRET, webhookBody)
    const okWebhookRes = await connectRequest('/api/v1/licensing/webhooks/stripe/connect', {
      method: 'POST',
      headers: { 'stripe-signature': goodSig },
      body: webhookBody,
    })
    expect(okWebhookRes.status).toBe(200)
    expect(await okWebhookRes.json()).toEqual({ status: 'processed' })

    const subRows = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId))
    expect(subRows).toHaveLength(1)
    expect(subRows[0]!.stripeSubscriptionId).toBe('sub_connect_1')
    expect(subRows[0]!.buyerEmail).toBe('connect-buyer@example.com')

    // Step 5: Disconnect calls /oauth/deauthorize and removes the credential row.
    const discRes = await connectRequest('/api/v1/payment-credentials/stripe/disconnect', {
      method: 'POST',
      headers: { cookie: sessionCookie },
    })
    expect(discRes.status).toBe(200)
    const deauthCall = recordedCalls.find((c) => c.url === 'https://connect.stripe.com/oauth/deauthorize')!
    expect(deauthCall.auth).toBe(`Bearer ${PLATFORM_SECRET_KEY}`)
    expect(deauthCall.body).toContain(`client_id=${CONNECT_CLIENT_ID}`)
    expect(deauthCall.body).toContain('stripe_user_id=acct_connected_1')

    const remainingCreds = await db
      .select()
      .from(paymentCredentials)
      .where(eq(paymentCredentials.tenantId, tenantId))
    expect(remainingCreds).toHaveLength(0)
  })

  it('unbinds stripeAccountId on account.application.deauthorized Connect webhook event', async () => {
    const { db, tenantId, sessionCookie } = await seedTenantWithUser()

    // Connect via mocked OAuth callback.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ stripe_user_id: 'acct_deauth_1', livemode: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    const startRes = await connectRequest('/api/v1/payment-credentials/stripe/connect', {
      headers: { cookie: sessionCookie },
    })
    const state = new URL(startRes.headers.get('location')!).searchParams.get('state')!
    const stateCookie = extractCookie(startRes, 'extport_stripe_oauth_state')!
    await connectRequest(
      `/api/v1/payment-credentials/stripe/callback?code=ac_deauth&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${sessionCookie}; ${stateCookie}` } },
    )

    const body = JSON.stringify({
      type: 'account.application.deauthorized',
      account: 'acct_deauth_1',
      data: { object: { id: 'ca_test_extport' } },
    })
    const sig = await signWebhook(CONNECT_WEBHOOK_SECRET, body)
    const res = await connectRequest('/api/v1/licensing/webhooks/stripe/connect', {
      method: 'POST',
      headers: { 'stripe-signature': sig },
      body,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'deauthorized' })

    const creds = await db.select().from(paymentCredentials).where(eq(paymentCredentials.tenantId, tenantId))
    expect(creds).toHaveLength(0)
  })
})
