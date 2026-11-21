// Minimal zero-SDK Stripe REST client built on native fetch + URLSearchParams.
// Matches extport's zero-heavy-SDK philosophy (see lib/stripe.ts).

const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com/v1'

/**
 * Resolves an optional Stripe API base URL override from Worker bindings
 * (used by local Playwright E2E tests against an in-process mock Stripe server).
 */
export function resolveStripeApiBase(env: unknown): string | undefined {
  if (typeof env === 'object' && env !== null && 'STRIPE_API_BASE' in env) {
    const value = (env as { STRIPE_API_BASE?: unknown }).STRIPE_API_BASE
    if (typeof value === 'string' && value.trim()) {
      return value.trim().replace(/\/+$/, '')
    }
  }
  return undefined
}

export class StripeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'StripeApiError'
  }
}

export function stripeErrorToHttp(err: StripeApiError): {
  status: 400 | 502
  body: { error: string; code?: string }
} {
  if (err.status >= 400 && err.status < 500 && err.status !== 429) {
    return {
      status: 400,
      body: { error: err.message, ...(err.code ? { code: err.code } : {}) },
    }
  }
  return {
    status: 502,
    body: { error: err.message, ...(err.code ? { code: err.code } : {}) },
  }
}

function appendMetadata(params: URLSearchParams, prefix: string, metadata?: Record<string, string>): void {
  if (!metadata) return
  for (const [key, value] of Object.entries(metadata)) {
    params.set(`${prefix}[${key}]`, value)
  }
}

async function stripePost<T>(apiKey: string, path: string, params: URLSearchParams, apiBase?: string): Promise<T> {
  const base = apiBase ? apiBase.replace(/\/+$/, '') : DEFAULT_STRIPE_API_BASE
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })
  } catch (err) {
    throw new StripeApiError(
      502,
      'network_error',
      err instanceof Error ? `Failed to reach Stripe API: ${err.message}` : 'Failed to reach Stripe API',
    )
  }

  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    data = null
  }

  if (!res.ok) {
    const errObj =
      typeof data === 'object' && data !== null && 'error' in data
        ? (data as { error?: { code?: unknown; type?: unknown; message?: unknown } }).error
        : undefined
    const code = typeof errObj?.code === 'string' ? errObj.code : typeof errObj?.type === 'string' ? errObj.type : null
    const message =
      typeof errObj?.message === 'string' && errObj.message.trim() ? errObj.message : `Stripe API error (${res.status})`
    throw new StripeApiError(res.status, code, message)
  }

  return data as T
}

export async function createStripeProduct(
  apiKey: string,
  input: { name: string; metadata?: Record<string, string>; apiBase?: string },
): Promise<{ id: string }> {
  const params = new URLSearchParams()
  params.set('name', input.name)
  appendMetadata(params, 'metadata', input.metadata)
  const product = await stripePost<{ id: string }>(apiKey, '/products', params, input.apiBase)
  return { id: product.id }
}

export async function createStripePrice(
  apiKey: string,
  input: {
    productId: string
    unitAmount: number
    currency: string
    interval?: 'month' | 'year'
    nickname?: string
    metadata?: Record<string, string>
    apiBase?: string
  },
): Promise<{ id: string }> {
  const params = new URLSearchParams()
  params.set('product', input.productId)
  params.set('unit_amount', String(input.unitAmount))
  params.set('currency', input.currency.toLowerCase())
  if (input.interval) params.set('recurring[interval]', input.interval)
  if (input.nickname) params.set('nickname', input.nickname)
  appendMetadata(params, 'metadata', input.metadata)
  const price = await stripePost<{ id: string }>(apiKey, '/prices', params, input.apiBase)
  return { id: price.id }
}

export async function archiveStripePrice(apiKey: string, priceId: string, apiBase?: string): Promise<void> {
  const params = new URLSearchParams()
  params.set('active', 'false')
  await stripePost<{ id: string }>(apiKey, `/prices/${encodeURIComponent(priceId)}`, params, apiBase)
}

export async function createStripeCheckoutSession(
  apiKey: string,
  input: {
    mode: 'payment' | 'subscription'
    priceId: string
    planId: string
    customerId?: string | null
    customerEmail?: string | null
    externalUserId?: string | null
    successUrl: string
    cancelUrl: string
    apiBase?: string
  },
): Promise<{ id: string; url: string }> {
  const params = new URLSearchParams()
  params.set('mode', input.mode)
  params.set('line_items[0][price]', input.priceId)
  params.set('line_items[0][quantity]', '1')
  params.set('metadata[extport_plan]', input.planId)
  params.set('allow_promotion_codes', 'true')
  params.set('success_url', input.successUrl)
  params.set('cancel_url', input.cancelUrl)
  if (input.externalUserId) params.set('client_reference_id', input.externalUserId)
  // Stripe rejects Checkout Session creation when both `customer` and `customer_email` are set.
  if (input.customerId) {
    params.set('customer', input.customerId)
  } else if (input.customerEmail) {
    params.set('customer_email', input.customerEmail)
  }
  if (input.mode === 'subscription') {
    params.set('subscription_data[metadata][extport_plan]', input.planId)
  }

  const session = await stripePost<{ id: string; url?: string | null }>(
    apiKey,
    '/checkout/sessions',
    params,
    input.apiBase,
  )
  if (!session.url) {
    throw new StripeApiError(502, 'missing_url', 'Stripe Checkout Session returned no URL')
  }
  return { id: session.id, url: session.url }
}

export async function createStripeBillingPortalSession(
  apiKey: string,
  input: { customerId: string; returnUrl: string; apiBase?: string },
): Promise<{ id: string; url: string }> {
  const params = new URLSearchParams()
  params.set('customer', input.customerId)
  params.set('return_url', input.returnUrl)
  const session = await stripePost<{ id: string; url?: string | null }>(
    apiKey,
    '/billing_portal/sessions',
    params,
    input.apiBase,
  )
  if (!session.url) {
    throw new StripeApiError(502, 'missing_url', 'Stripe Billing Portal Session returned no URL')
  }
  return { id: session.id, url: session.url }
}

export async function updateStripeSubscription(
  apiKey: string,
  input: { subscriptionId: string; cancelAtPeriodEnd: boolean; apiBase?: string },
): Promise<{ id: string; status: string; cancelAtPeriodEnd: boolean }> {
  const params = new URLSearchParams()
  params.set('cancel_at_period_end', input.cancelAtPeriodEnd ? 'true' : 'false')
  // Stripe Billing Portal in flexible billing mode cancels via `cancel_at`
  // (leaving `cancel_at_period_end: false`), so resuming must clear `cancel_at` too.
  if (!input.cancelAtPeriodEnd) {
    params.set('cancel_at', '')
  }
  const sub = await stripePost<{
    id: string
    status?: string
    cancel_at_period_end?: boolean
    cancel_at?: number | null
  }>(apiKey, `/subscriptions/${encodeURIComponent(input.subscriptionId)}`, params, input.apiBase)
  return {
    id: sub.id,
    status: sub.status ?? 'active',
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end || sub.cancel_at),
  }
}
