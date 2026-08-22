import { Hono } from 'hono'
import { generateSpecs, openAPIRouteHandler } from 'hono-openapi'
import { requireAuth, type AppEnv } from './middleware/auth'
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

// The API surface and its OpenAPI document live together. The worker entry
// (index.ts) just mounts this `api` router; the docs site regenerates the
// spec from it via the `@extport/api/openapi` entry.
export const api = new Hono<AppEnv>()

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

type OpenApiDocumentation = NonNullable<NonNullable<Parameters<typeof openAPIRouteHandler>[1]>['documentation']>

export const OPENAPI_DOCUMENTATION: OpenApiDocumentation = {
  info: { title: 'extport API', version: '1.0.0', description: 'Publish and manage browser extension releases across Chrome, Firefox, Edge, and Safari.' },
  // openAPIRouteHandler was handed `api` (the /api-mounted sub-router), so
  // every generated path is relative to it, e.g. "/v1/artifacts" — the
  // server URL has to carry the /api prefix back for paths to resolve
  // to the real, callable endpoint.
  // `api.extport.dev` is the dedicated API host (the SDK's default apiBase);
  // `dash` is the dashboard SPA host and is not where generated clients should
  // be pointed.
  servers: [{ url: 'https://api.extport.dev/api', description: 'Production' }],
  // Auth is applied by custom middleware (requireAuth/requireSession/…), which
  // hono-openapi can't introspect, so it's declared here instead. The document
  // default is "API key OR dashboard session"; public and session-only
  // operations override it via `security` on their describeRoute.
  security: [{ apiKey: [] }, { session: [] }],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        description: 'Tenant API key, sent as `Authorization: Bearer <key>`. Generated in the dashboard or via `extport login`.'
      },
      session: { type: 'apiKey', in: 'cookie', name: 'extport_session', description: 'Dashboard session cookie.' },
      buyerSession: { type: 'apiKey', in: 'cookie', name: 'extport_buyer_session', description: 'Buyer portal session cookie.' },
    },
  },
  tags: [
    { name: 'Analytics', description: 'One-anonymous-ping-a-day usage analytics: installs, weekly actives, and version adoption across every store.' },
    { name: 'API keys', description: 'Tenant API keys for automation. Session-only: an API key must never mint or revoke another.' },
    { name: 'Artifacts', description: 'Push a build and it is submitted to every store you have connected.' },
    { name: 'Buyer portal', description: 'The shopper-facing surface: order lookup, magic-link sign-in, and a read-only purchase list.' },
    { name: 'CLI login', description: '`extport login` — a session-only exchange that mints a one-time code the CLI redeems for an API key.' },
    { name: 'Extensions', description: 'Your extension fleet: create, update, reconcile, and inspect publishing status across stores.' },
    { name: 'Licensing', description: 'Plans, issued licenses, activations, Stripe Payment Link fulfillment, and the end-user verify/activate flow.' },
    { name: 'Store credentials', description: 'Store API credentials and their verification status. Session-only: secrets never leave the dashboard.' },
    { name: 'Tenant', description: 'Workspace settings.' },
  ],
}

// Public — the live, always-in-sync spec endpoint. A third-party developer can
// hand this to a client generator without asking us for it.
api.get('/openapi.json', openAPIRouteHandler(api, { documentation: OPENAPI_DOCUMENTATION }))

// Offline, runtime-independent re-generation of the OpenAPI spec — used by the
// docs site (apps/docs/scripts/generate-openapi.ts). Defined here rather than
// in the docs package so it runs against the same hono-openapi instance whose
// describeRoute/validator metadata was attached to `api`; importing
// `generateSpecs` from a second copy (as docs would) breaks the shared
// uniqueSymbol and yields an empty document.
export function generateOpenApiSpec() {
  return generateSpecs(api, { documentation: OPENAPI_DOCUMENTATION })
}

api.get('/v1/me', requireAuth, (c) => {
  const tenant = c.get('tenant')
  const user = c.get('user')
  return c.json({
    authType: c.get('authType'),
    tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan, status: tenant.status },
    user: user ? { id: user.id, email: user.email, displayName: user.displayName } : null,
  })
})
