import { encryptJson, newId, randomBytes, toBase64 } from '@extport/shared'
import { and, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { describeRoute } from 'hono-openapi'
import { paymentCredentials, type PaymentCredential } from '../db'
import { tenantDek } from '../lib/kms'
import {
  deauthorizeStripeAccount,
  exchangeStripeOAuthCode,
  resolveStripeOAuthBase,
  StripeApiError,
} from '../lib/stripe-api'
import { loadStripeCredential } from '../lib/stripe-credentials'
import { requireActiveTenant, requireSession, type AppEnv } from '../middleware/auth'

// Stripe Connect Standard OAuth2 credentials, dashboard-managed only — an API
// key must never read or mutate payment credentials.
const route = new Hono<AppEnv>()

const STRIPE_OAUTH_STATE_COOKIE = 'extport_stripe_oauth_state'

route.use('*', requireSession, requireActiveTenant)

function isConnectConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_CONNECT_CLIENT_ID?.trim() && env.STRIPE_SECRET_KEY?.trim())
}

function settingsRedirectUrl(env: Env, params: Record<string, string>): string {
  const url = new URL('/settings', env.DASHBOARD_URL)
  for (const [k, val] of Object.entries(params)) {
    url.searchParams.set(k, val)
  }
  url.hash = 'payment-credentials'
  return url.toString()
}

function publicView(row: PaymentCredential) {
  return {
    id: row.id,
    provider: row.provider,
    stripeAccountId: row.stripeAccountId ?? null,
    connected: Boolean(row.stripeAccountId),
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
    return c.json({
      credentials: rows.filter((r) => Boolean(r.stripeAccountId)).map(publicView),
      connectEnabled: isConnectConfigured(c.env),
    })
  },
)

route.get(
  '/stripe/connect',
  describeRoute({
    summary: 'Start Stripe Connect Standard OAuth2 flow',
    description:
      'Redirects the signed-in tenant to Stripe Connect OAuth2 with a CSRF state cookie so they can connect their Standard Stripe account in one click.',
    tags: ['Licensing'],
    security: [{ session: [] }],
    responses: {
      302: { description: 'Redirect to Stripe Connect OAuth' },
      503: { description: 'Stripe Connect OAuth is not configured on this deployment' },
    },
  }),
  (c) => {
    if (!isConnectConfigured(c.env)) {
      return c.json({ error: 'Stripe Connect OAuth is not configured' }, 503)
    }
    const tenant = c.get('tenant')
    const state = toBase64(randomBytes(16)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    setCookie(c, STRIPE_OAUTH_STATE_COOKIE, `${tenant.id}:${state}`, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    })

    const oauthBase = resolveStripeOAuthBase(c.env)
    const redirectUri = new URL('/api/v1/payment-credentials/stripe/callback', c.env.DASHBOARD_URL).toString()
    const url = new URL(`${oauthBase}/oauth/authorize`)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', c.env.STRIPE_CONNECT_CLIENT_ID!.trim())
    url.searchParams.set('scope', 'read_write')
    url.searchParams.set('state', state)
    url.searchParams.set('redirect_uri', redirectUri)
    return c.redirect(url.toString())
  },
)

route.get(
  '/stripe/callback',
  describeRoute({
    summary: 'Complete Stripe Connect Standard OAuth2 flow',
    description: 'Verifies the CSRF state cookie, exchanges the authorization code for acct_…, and binds it to the tenant.',
    tags: ['Licensing'],
    security: [{ session: [] }],
    responses: {
      302: { description: 'Redirect back to Settings' },
    },
  }),
  async (c) => {
    const { code, state, error } = c.req.query()
    const expectedCookie = getCookie(c, STRIPE_OAUTH_STATE_COOKIE)
    deleteCookie(c, STRIPE_OAUTH_STATE_COOKIE, { path: '/' })

    if (error) {
      return c.redirect(settingsRedirectUrl(c.env, { stripe_error: error === 'access_denied' ? 'cancelled' : error }))
    }

    const tenant = c.get('tenant')
    if (!code || !state || !expectedCookie || expectedCookie !== `${tenant.id}:${state}`) {
      return c.redirect(settingsRedirectUrl(c.env, { stripe_error: 'invalid_state' }))
    }
    if (!isConnectConfigured(c.env)) {
      return c.redirect(settingsRedirectUrl(c.env, { stripe_error: 'not_configured' }))
    }

    let stripeAccountId: string
    try {
      const exchanged = await exchangeStripeOAuthCode(
        c.env.STRIPE_SECRET_KEY!.trim(),
        code,
        resolveStripeOAuthBase(c.env),
      )
      stripeAccountId = exchanged.stripeUserId
    } catch (err) {
      const reason = err instanceof StripeApiError ? (err.code ?? 'oauth_failed') : 'oauth_failed'
      return c.redirect(settingsRedirectUrl(c.env, { stripe_error: reason }))
    }

    const db = c.get('db')
    const [conflict] = await db
      .select({ id: paymentCredentials.id })
      .from(paymentCredentials)
      .where(
        and(
          eq(paymentCredentials.provider, 'stripe'),
          eq(paymentCredentials.stripeAccountId, stripeAccountId),
          ne(paymentCredentials.tenantId, tenant.id),
        ),
      )
    if (conflict) {
      return c.redirect(settingsRedirectUrl(c.env, { stripe_error: 'account_in_use' }))
    }

    const existing = await loadStripeCredential(c.env, db, tenant)
    if (existing) {
      await db
        .update(paymentCredentials)
        .set({ stripeAccountId })
        .where(eq(paymentCredentials.id, existing.row.id))
    } else {
      const dek = await tenantDek(c.env, tenant)
      const encryptedPayload = await encryptJson(dek, {})
      await db.insert(paymentCredentials).values({
        id: newId('paymentCredential'),
        tenantId: tenant.id,
        provider: 'stripe',
        hint: '',
        apiKeyHint: null,
        stripeAccountId,
        encryptedPayload,
        keyVersion: tenant.dekKeyVersion,
      })
    }

    return c.redirect(settingsRedirectUrl(c.env, { stripe: 'connected' }))
  },
)

route.post(
  '/stripe/disconnect',
  describeRoute({
    summary: 'Disconnect a Stripe Connect Standard account',
    description: 'Revokes the OAuth authorization with Stripe (best-effort) and unbinds stripeAccountId from the tenant.',
    tags: ['Licensing'],
    security: [{ session: [] }],
    responses: { 200: { description: 'Disconnected' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const existing = await loadStripeCredential(c.env, db, tenant)
    if (!existing?.stripeAccountId) {
      return c.json({ ok: true })
    }

    if (isConnectConfigured(c.env)) {
      try {
        await deauthorizeStripeAccount(
          c.env.STRIPE_SECRET_KEY!.trim(),
          c.env.STRIPE_CONNECT_CLIENT_ID!.trim(),
          existing.stripeAccountId,
          resolveStripeOAuthBase(c.env),
        )
      } catch {
        // Best-effort deauthorize — ignore if the user already revoked access in Stripe Dashboard.
      }
    }

    await db.delete(paymentCredentials).where(eq(paymentCredentials.id, existing.row.id))
    return c.json({ ok: true })
  },
)

export default route
