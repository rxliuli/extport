# extport

Browser extension publishing & licensing platform. Multi-tenant SaaS on Cloudflare
Workers + D1 + R2; the author is "tenant zero" and uses the exact same code paths
as external tenants.

Two independent per-extension modules:

- **Publishing** (Phase 1, in progress) — reconciliation-loop based store publishing
  (Chrome / Firefox / Edge / Apple), latest-wins versioning, status matrix, notifications.
- **Licensing** (Phase 2, schema pre-defined) — BYO-Stripe activation codes with
  offline verification (Ed25519), seat decay, buyer magic-link pages.

## Layout

| Path | Purpose |
|------|---------|
| `apps/api` | Workers API (Hono): auth, tenants, artifacts, reconciliation loop |
| `apps/dashboard` | Tenant dashboard (React + Vite) |
| `packages/shared` | IDs, envelope encryption, API keys, shared types |
| `packages/store-adapters` | `StoreAdapter` interface + per-store implementations |
| `packages/sdk` | Open-source license verification SDK (Phase 2) |

## Development

```sh
pnpm install
cd apps/api
cp .dev.vars.example .dev.vars       # fill KEK_V1 (openssl rand -base64 32) + GitHub OAuth secret
pnpm db:migrate:local                # apply D1 migrations locally
pnpm dev                             # API on :8787
# in another terminal
pnpm --filter @extport/dashboard dev # dashboard on :5173, proxies /auth and /v1 to :8787
```

Tests & checks:

```sh
pnpm test        # unit tests (packages/shared) + integration tests (apps/api, workers pool)
pnpm typecheck
```

After changing `apps/api/wrangler.jsonc` or `.dev.vars`, regenerate types with
`pnpm --filter @extport/api types`. After changing `src/db/schema.ts`, run
`pnpm --filter @extport/api db:generate` to emit a new migration.

## Security model (implemented)

- **Envelope encryption**: per-tenant AES-256-GCM DEK, wrapped by a versioned
  master KEK that lives only in Workers secrets (`KEK_V<n>` +
  `CURRENT_KEK_VERSION`). Store credentials are encrypted with the tenant DEK;
  D1 only ever holds ciphertext.
- **API keys**: `sk_live_…`, shown once at creation, only the SHA-256 hash is
  stored; keys cannot create or revoke other keys (session-only routes).
- **Sessions**: opaque tokens, hashed at rest, 30-day expiry, HttpOnly cookies.

## Deploying (first time)

```sh
cd apps/api
wrangler d1 create extport            # put the id into wrangler.jsonc
wrangler r2 bucket create extport-artifacts
wrangler secret put KEK_V1            # openssl rand -base64 32
wrangler secret put GITHUB_CLIENT_SECRET
pnpm db:migrate:remote
pnpm deploy
```
