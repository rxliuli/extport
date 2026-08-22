import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { runAnalyticsRollup } from './analytics/rollup'
import { createWaeQuery } from './analytics/wae'
import { createDb } from './db'
import { createEmailNotifier } from './lib/notify'
import { api } from './openapi'
import { checkCredentialExpiry } from './reconcile/expiry'
import type { ReconcileJob } from './reconcile/queue'
import { runReconciliation } from './reconcile/run'
import { withDb, type AppEnv } from './middleware/auth'

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
  // Drizzle wraps the real D1 error in `cause` — without it, an outage logs
  // as an opaque "Failed query: select ..." (2026-08-19).
  const cause = err.cause instanceof Error ? err.cause.message : err.cause
  console.error(JSON.stringify({ level: 'error', message: err.message, cause, stack: err.stack }))
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
  // Push-triggered reconciles land here (see enqueueReconcile and the
  // "queues" block in wrangler.jsonc): a consumer invocation gets 15
  // minutes of wall clock, where the old ctx.waitUntil path was killed ~30
  // seconds after the HTTP response — mid-submit, when a store was slow.
  async queue(batch, env) {
    const db = createDb(env.DB)
    const notifier = createEmailNotifier(env)
    for (const message of batch.messages) {
      try {
        const summary = await runReconciliation(env, db, message.body, notifier)
        console.log(JSON.stringify({ level: 'info', message: 'reconcile job complete', ...message.body, ...summary }))
        message.ack()
      } catch (err) {
        // runReconciliation persists per-target errors itself — reaching
        // here is an infrastructure-level failure; let the queue redeliver.
        console.error(JSON.stringify({ level: 'error', message: `reconcile job failed: ${(err as Error).message}`, ...message.body }))
        message.retry({ delaySeconds: 60 })
      }
    }
  },
} satisfies ExportedHandler<Env, ReconcileJob>
