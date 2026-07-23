import { Scalar } from '@scalar/hono-api-reference'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { openAPIRouteHandler } from 'hono-openapi'
import { createDb } from './db'
import { createEmailNotifier } from './lib/notify'
import { checkCredentialExpiry } from './reconcile/expiry'
import { runReconciliation } from './reconcile/run'
import artifactsRoutes from './routes/artifacts'
import authRoutes from './routes/auth'
import cliAuthRoutes from './routes/cli-auth'
import credentialsRoutes from './routes/credentials'
import extensionsRoutes from './routes/extensions'
import keysRoutes from './routes/keys'
import tenantRoutes from './routes/tenant'
import { requireAuth, withDb, type AppEnv } from './middleware/auth'

const app = new Hono<AppEnv>()

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
  async scheduled(_controller, env, ctx) {
    const db = createDb(env.DB)
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
