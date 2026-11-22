// Optional runtime bindings that live in secrets / .dev.vars / E2E overrides
// rather than wrangler.jsonc vars (so wrangler types doesn't always emit them).
interface Env {
  STRIPE_CONNECT_CLIENT_ID?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_CONNECT_WEBHOOK_SECRET?: string
  STRIPE_API_BASE?: string
  STRIPE_CONNECT_OAUTH_BASE?: string
}
