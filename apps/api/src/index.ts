import { Scalar } from '@scalar/hono-api-reference'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { openAPIRouteHandler } from 'hono-openapi'
import { runAnalyticsRollup } from './analytics/rollup'
import { createWaeQuery } from './analytics/wae'
import { createDb } from './db'
import { createEmailNotifier } from './lib/notify'
import { checkCredentialExpiry } from './reconcile/expiry'
import { runReconciliation } from './reconcile/run'
import artifactsRoutes from './routes/artifacts'
import authRoutes from './routes/auth'
import cliAuthRoutes from './routes/cli-auth'
import credentialsRoutes from './routes/credentials'
import { analyticsPublicRoutes, analyticsTenantRoutes } from './routes/analytics'
import extensionsRoutes from './routes/extensions'
import keysRoutes from './routes/keys'
import licensesRoutes from './routes/licenses'
import licensingRoutes from './routes/licensing'
import paymentCredentialsRoutes from './routes/payment-credentials'
import plansRoutes from './routes/plans'
import portalRoutes from './routes/portal'
import stripeWebhookRoutes from './routes/stripe-webhook'
import tenantRoutes from './routes/tenant'
import { requireAuth, withDb, type AppEnv } from './middleware/auth'

// Must match a member of wrangler.jsonc's triggers.crons exactly.
const ANALYTICS_ROLLUP_CRON = '15 0 * * *'

const app = new Hono<AppEnv>()

// Host-based surface isolation. One Worker serves three custom domains, and
// with `run_worker_first: true` every request lands here first — so this is
// the single place that keeps each domain to its own surface (previously the
// asset layer served the dashboard SPA on any host, e.g. api.extport.dev/login).
// Unknown hosts (localhost dev, *.workers.dev, tests) behave like dash: fully open.
const PORTAL_PATHS = [/^\/portal/, /^\/purchase/, /^\/assets\//, /^\/favicon/, /^\/api\/v1\/portal\//]
app.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  if (url.hostname === 'api.extport.dev' && !url.pathname.startsWith('/api')) {
    return c.json({ error: 'not found' }, 404)
  }
  if (url.hostname === 'portal.extport.dev' && !PORTAL_PATHS.some((re) => re.test(url.pathname))) {
    // API paths outside the portal surface are hidden; everything else is a
    // human who typed a dashboard URL on the wrong host — send them home.
    if (url.pathname.startsWith('/api')) return c.json({ error: 'not found' }, 404)
    return c.redirect('/portal', 302)
  }
  await next()
})

app.use('*', withDb)

// Everything lives under /api so the deployed Worker needs exactly one
// asset-routing rule (`run_worker_first: ["/api/*"]`) and the SPA keeps the
// entire top-level path namespace to itself.
const api = new Hono<AppEnv>()

api.get('/healthz', (c) => c.json({ ok: true }))

api.route('/auth', authRoutes)
api.route('/v1/cli-auth', cliAuthRoutes)
api.route('/v1/keys', keysRoutes)
api.route('/v1/extensions', extensionsRoutes)
api.route('/v1/artifacts', artifactsRoutes)
api.route('/v1/credentials', credentialsRoutes)
api.route('/v1/tenant', tenantRoutes)
// /v1/licensing is public — called by end users' devices, keyed by license
// code alone; the stripe webhook receiver is public too, authenticated by
// signature. plans/licenses/payment-credentials are tenant-authed.
api.route('/v1/licensing', licensingRoutes)
api.route('/v1/licensing/webhooks/stripe', stripeWebhookRoutes)
// Buyer portal (portal.extport.dev): success-page lookup + magic-link
// sign-in + read-only purchase list. Cookie-authed, same-origin.
api.route('/v1/portal', portalRoutes)
// /v1/analytics/ping is public (extension backgrounds, CORS-open); the
// series/overview reads on the same prefix are tenant-authed.
api.route('/v1/analytics', analyticsPublicRoutes)
api.route('/v1/analytics', analyticsTenantRoutes)
api.route('/v1/plans', plansRoutes)
api.route('/v1/licenses', licensesRoutes)
api.route('/v1/payment-credentials', paymentCredentialsRoutes)

// Public — this is the whole point of generating it (docs/spec a third-party
// developer can hand to a client generator without needing to ask us for it).
api.get(
  '/openapi.json',
  openAPIRouteHandler(api, {
    documentation: {
      info: { title: 'extport API', version: '1.0.0', description: 'Publish and manage browser extension releases across Chrome, Firefox, Edge, and Safari.' },
      // openAPIRouteHandler was handed `api` (the /api-mounted sub-router), so
      // every generated path is relative to it, e.g. "/v1/artifacts" — the
      // server URL has to carry the /api prefix back for paths to resolve
      // to the real, callable endpoint.
      servers: [{ url: 'https://dash.extport.dev/api', description: 'Production' }],
    },
  }),
)
api.get('/docs', Scalar({ url: '/api/openapi.json', pageTitle: 'extport API' }))

api.get('/v1/me', requireAuth, (c) => {
  const tenant = c.get('tenant')
  const user = c.get('user')
  return c.json({
    authType: c.get('authType'),
    tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan, status: tenant.status },
    user: user ? { id: user.id, email: user.email, displayName: user.displayName } : null,
  })
})

app.route('/api', api)

// With run_worker_first: true, non-API paths no longer reach the asset layer
// on their own — hand them over explicitly (the binding still applies the
// SPA fallback). Unit tests run without built dashboard assets; the binding
// check degrades those to a plain 404 instead of crashing.
app.all('*', async (c) => {
  if (!c.req.path.startsWith('/api') && c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw)
  }
  return c.json({ error: 'not found' }, 404)
})

app.notFound((c) => c.json({ error: 'not found' }, 404))

app.onError((err, c) => {
  // Hono's own middleware throws this for things like malformed JSON bodies
  // (validator()) — it already carries the right status and a clean
  // message; the fallback below would otherwise flatten it into an opaque
  // 500, same as any other unrelated bug.
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
  console.error(JSON.stringify({ level: 'error', message: err.message, stack: err.stack }))
  return c.json({ error: 'internal error' }, 500)
})

// Named export for tests (Hono's `.request()` test helper); the default
// export below is what the Workers runtime actually loads.
export { app }

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    const db = createDb(env.DB)
    // The nightly trigger only rolls up analytics; the half-hourly one
    // only reconciles. Dispatch on the cron expression itself.
    if (controller.cron === ANALYTICS_ROLLUP_CRON) {
      // DAU/WAU are read from Analytics Engine, which — unlike the write-only
      // ANALYTICS binding — is only reachable over the SQL API with an
      // account-scoped token. Without it the rollup would quietly record zero
      // activity for every extension, so refuse to run instead.
      if (!env.ANALYTICS_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
        console.error(JSON.stringify({ level: 'error', message: 'analytics rollup skipped: ANALYTICS_API_TOKEN or CLOUDFLARE_ACCOUNT_ID not configured' }))
        return
      }
      const waeQuery = createWaeQuery({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.ANALYTICS_API_TOKEN })
      ctx.waitUntil(
        runAnalyticsRollup(db, new Date(), waeQuery).then(({ day }) => {
          console.log(JSON.stringify({ level: 'info', message: 'analytics rollup complete', day }))
        }),
      )
      return
    }
    const notifier = createEmailNotifier(env)
    // waitUntil so the cron invocation doesn't get torn down mid-reconcile —
    // scheduled() itself has no response to return, this is the whole job.
    ctx.waitUntil(
      Promise.all([
        runReconciliation(env, db, {}, notifier).then((summary) => {
          console.log(JSON.stringify({ level: 'info', message: 'reconcile tick complete', ...summary }))
        }),
        checkCredentialExpiry(db, notifier),
      ]),
    )
  },
} satisfies ExportedHandler<Env>
