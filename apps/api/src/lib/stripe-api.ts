// Minimal zero-SDK Stripe REST client built on native fetch + URLSearchParams.
// Matches extport's zero-heavy-SDK philosophy (see lib/stripe.ts).

const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com/v1'
const DEFAULT_STRIPE_OAUTH_BASE = 'https://connect.stripe.com'

export interface StripeAuth {
  apiKey: string
  /** Connected Standard account ID (acct_...); sent as `Stripe-Account` header. */
  stripeAccountId?: string | null
}

export type StripeAuthInput = string | StripeAuth

function normalizeAuth(auth: StripeAuthInput): StripeAuth {
  return typeof auth === 'string' ? { apiKey: auth } : auth
}

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

export function resolveStripeOAuthBase(env: unknown): string {
  if (typeof env === 'object' && env !== null && 'STRIPE_CONNECT_OAUTH_BASE' in env) {
    const value = (env as { STRIPE_CONNECT_OAUTH_BASE?: unknown }).STRIPE_CONNECT_OAUTH_BASE
    if (typeof value === 'string' && value.trim()) {
      return value.trim().replace(/\/+$/, '')
    }
  }
  return DEFAULT_STRIPE_OAUTH_BASE
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

async function stripeRequest<T>(
  authInput: StripeAuthInput,
  method: 'GET' | 'POST',
  path: string,
  params?: URLSearchParams,
  apiBase?: string,
): Promise<T> {
  const auth = normalizeAuth(authInput)
  const base = apiBase ? apiBase.replace(/\/+$/, '') : DEFAULT_STRIPE_API_BASE
  const qs = method === 'GET' && params && [...params.keys()].length > 0 ? `?${params.toString()}` : ''
  let res: Response
  try {
    res = await fetch(`${base}${path}${qs}`, {
      method,
      headers: {
        authorization: `Bearer ${auth.apiKey}`,
        ...(auth.stripeAccountId ? { 'stripe-account': auth.stripeAccountId } : {}),
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(method === 'POST' && params ? { body: params.toString() } : {}),
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

async function stripePost<T>(auth: StripeAuthInput, path: string, params: URLSearchParams, apiBase?: string): Promise<T> {
  return stripeRequest<T>(auth, 'POST', path, params, apiBase)
}

async function stripeGet<T>(auth: StripeAuthInput, path: string, params?: URLSearchParams, apiBase?: string): Promise<T> {
  return stripeRequest<T>(auth, 'GET', path, params, apiBase)
}

export async function exchangeStripeOAuthCode(
  secretKey: string,
  code: string,
  oauthBase?: string,
): Promise<{ stripeUserId: string; livemode: boolean; scope: string | null }> {
  const base = oauthBase ? oauthBase.replace(/\/+$/, '') : DEFAULT_STRIPE_OAUTH_BASE
  const params = new URLSearchParams()
  params.set('grant_type', 'authorization_code')
  params.set('code', code)

  let res: Response
  try {
    res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })
  } catch (err) {
    throw new StripeApiError(
      502,
      'network_error',
      err instanceof Error ? `Failed to reach Stripe OAuth: ${err.message}` : 'Failed to reach Stripe OAuth',
    )
  }

  let data: Record<string, unknown> | null = null
  try {
    data = (await res.json()) as Record<string, unknown>
  } catch {
    data = null
  }

  if (!res.ok) {
    const codeStr = typeof data?.['error'] === 'string' ? data['error'] : null
    const desc =
      typeof data?.['error_description'] === 'string' && data['error_description'].trim()
        ? data['error_description']
        : `Stripe OAuth error (${res.status})`
    throw new StripeApiError(res.status, codeStr, desc)
  }

  const stripeUserId = typeof data?.['stripe_user_id'] === 'string' ? data['stripe_user_id'].trim() : ''
  if (!stripeUserId) {
    throw new StripeApiError(502, 'missing_account', 'Stripe OAuth token response omitted stripe_user_id')
  }
  return {
    stripeUserId,
    livemode: Boolean(data?.['livemode']),
    scope: typeof data?.['scope'] === 'string' ? data['scope'] : null,
  }
}

export async function deauthorizeStripeAccount(
  secretKey: string,
  clientId: string,
  stripeAccountId: string,
  oauthBase?: string,
): Promise<void> {
  const base = oauthBase ? oauthBase.replace(/\/+$/, '') : DEFAULT_STRIPE_OAUTH_BASE
  const params = new URLSearchParams()
  params.set('client_id', clientId)
  params.set('stripe_user_id', stripeAccountId)

  let res: Response
  try {
    res = await fetch(`${base}/oauth/deauthorize`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })
  } catch (err) {
    throw new StripeApiError(
      502,
      'network_error',
      err instanceof Error ? `Failed to reach Stripe OAuth: ${err.message}` : 'Failed to reach Stripe OAuth',
    )
  }

  if (!res.ok) {
    let data: Record<string, unknown> | null = null
    try {
      data = (await res.json()) as Record<string, unknown>
    } catch {
      data = null
    }
    const codeStr = typeof data?.['error'] === 'string' ? data['error'] : null
    const desc =
      typeof data?.['error_description'] === 'string' && data['error_description'].trim()
        ? data['error_description']
        : `Stripe OAuth deauthorize error (${res.status})`
    throw new StripeApiError(res.status, codeStr, desc)
  }
}

export async function createStripeProduct(
  auth: StripeAuthInput,
  input: { name: string; metadata?: Record<string, string>; apiBase?: string },
): Promise<{ id: string }> {
  const params = new URLSearchParams()
  params.set('name', input.name)
  appendMetadata(params, 'metadata', input.metadata)
  const product = await stripePost<{ id: string }>(auth, '/products', params, input.apiBase)
  return { id: product.id }
}

export async function createStripePrice(
  auth: StripeAuthInput,
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
  const price = await stripePost<{ id: string }>(auth, '/prices', params, input.apiBase)
  return { id: price.id }
}

export async function archiveStripePrice(auth: StripeAuthInput, priceId: string, apiBase?: string): Promise<void> {
  const params = new URLSearchParams()
  params.set('active', 'false')
  await stripePost<{ id: string }>(auth, `/prices/${encodeURIComponent(priceId)}`, params, apiBase)
}

export async function createStripeCheckoutSession(
  auth: StripeAuthInput,
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
    auth,
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
  auth: StripeAuthInput,
  input: { customerId: string; returnUrl: string; apiBase?: string },
): Promise<{ id: string; url: string }> {
  const params = new URLSearchParams()
  params.set('customer', input.customerId)
  params.set('return_url', input.returnUrl)
  const session = await stripePost<{ id: string; url?: string | null }>(
    auth,
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
  auth: StripeAuthInput,
  input: { subscriptionId: string; cancelAtPeriodEnd: boolean; apiBase?: string },
): Promise<{ id: string; status: string; cancelAtPeriodEnd: boolean }> {
  const path = `/subscriptions/${encodeURIComponent(input.subscriptionId)}`
  const params = new URLSearchParams()

  if (input.cancelAtPeriodEnd) {
    params.set('cancel_at_period_end', 'true')
  } else {
    // Stripe rejects passing both `cancel_at_period_end` and `cancel_at` in one request.
    // Inspect the subscription first so we clear whichever field Stripe actually set
    // (Billing Portal / Dashboard flexible cancellations set `cancel_at`; API cancels set `cancel_at_period_end`).
    const current = await stripeGet<{
      id: string
      status?: string
      cancel_at_period_end?: boolean
      cancel_at?: number | null
    }>(auth, path, undefined, input.apiBase)
    if (current.cancel_at != null && !current.cancel_at_period_end) {
      params.set('cancel_at', '')
    } else {
      params.set('cancel_at_period_end', 'false')
    }
  }

  const sub = await stripePost<{
    id: string
    status?: string
    cancel_at_period_end?: boolean
    cancel_at?: number | null
  }>(auth, path, params, input.apiBase)
  return {
    id: sub.id,
    status: sub.status ?? 'active',
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end || sub.cancel_at),
  }
}

export interface StripeInvoiceSummary {
  id: string
  number: string | null
  status: string | null
  amountPaid: number
  currency: string
  createdAt: string
  invoicePdf: string | null
  hostedInvoiceUrl: string | null
}

export async function listStripeInvoices(
  auth: StripeAuthInput,
  input: { subscriptionId?: string | null; customerId?: string | null; limit?: number; apiBase?: string },
): Promise<StripeInvoiceSummary[]> {
  const params = new URLSearchParams()
  if (input.subscriptionId) params.set('subscription', input.subscriptionId)
  else if (input.customerId) params.set('customer', input.customerId)
  params.set('limit', String(input.limit ?? 24))
  const res = await stripeGet<{
    data?: Array<{
      id: string
      number?: string | null
      status?: string | null
      amount_paid?: number | null
      currency?: string | null
      created?: number | null
      invoice_pdf?: string | null
      hosted_invoice_url?: string | null
    }>
  }>(auth, '/invoices', params, input.apiBase)
  return (res.data ?? []).map((inv) => ({
    id: inv.id,
    number: inv.number ?? null,
    status: inv.status ?? null,
    amountPaid: inv.amount_paid ?? 0,
    currency: (inv.currency ?? 'usd').toLowerCase(),
    createdAt: typeof inv.created === 'number' ? new Date(inv.created * 1000).toISOString() : new Date().toISOString(),
    invoicePdf: inv.invoice_pdf ?? null,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
  }))
}
