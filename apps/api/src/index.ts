import { Hono } from 'hono'
import { createDb } from './db'
import { runReconciliation } from './reconcile/run'
import artifactsRoutes from './routes/artifacts'
import authRoutes from './routes/auth'
import credentialsRoutes from './routes/credentials'
import extensionsRoutes from './routes/extensions'
import keysRoutes from './routes/keys'
import { requireAuth, withDb, type AppEnv } from './middleware/auth'

const app = new Hono<AppEnv>()

app.use('*', withDb)

app.get('/healthz', (c) => c.json({ ok: true }))

app.route('/auth', authRoutes)
app.route('/v1/keys', keysRoutes)
app.route('/v1/extensions', extensionsRoutes)
app.route('/v1/artifacts', artifactsRoutes)
app.route('/v1/credentials', credentialsRoutes)

app.get('/v1/me', requireAuth, (c) => {
  const tenant = c.get('tenant')
  const user = c.get('user')
  return c.json({
    authType: c.get('authType'),
    tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan },
    user: user ? { id: user.id, email: user.email, displayName: user.displayName } : null,
  })
})

app.notFound((c) => c.json({ error: 'not found' }, 404))

app.onError((err, c) => {
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
    // waitUntil so the cron invocation doesn't get torn down mid-reconcile —
    // scheduled() itself has no response to return, this is the whole job.
    ctx.waitUntil(
      runReconciliation(env, db).then((summary) => {
        console.log(JSON.stringify({ level: 'info', message: 'reconcile tick complete', ...summary }))
      }),
    )
  },
} satisfies ExportedHandler<Env>
