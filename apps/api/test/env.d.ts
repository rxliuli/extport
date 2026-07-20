// Test-only additions to the worker Env (provided via miniflare bindings in
// vitest.config.ts). Merges into the wrangler-generated Cloudflare.Env.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
}
