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
| `packages/shared` | IDs, envelope encryption, API keys, version utils, shared types |
| `packages/store-adapters` | `StoreAdapter` interface + per-store implementations |
| `packages/cli` | `extport` CLI (`npx extport push dist.zip …`) |
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

## Uploading artifacts from CI

```sh
# one line in any CI job; EXTPORT_API_KEY from Settings → API keys
npx extport push dist.zip --extension my-extension --version 1.2.3
# store-specific builds:
npx extport push dist-chrome.zip --extension my-extension --version 1.2.3 --store chrome
```

Versions are immutable: identical re-uploads are idempotent (200), changed
content for an existing version is rejected (409) — bump the version instead.

## Store credentials

Added in the dashboard (Settings → Store credentials); verified against the
live store API before saving, then envelope-encrypted with the tenant DEK.
Only the last four characters are ever displayed again.

| Store | What the tenant pastes |
|-------|------------------------|
| Chrome | Web Store Publish API **v2** service account: Publisher ID + service account email + private key (JSON key from GCP, no OAuth consent screen) |
| Firefox | AMO JWT issuer + secret |
| Edge | Partner Center Client ID + API key (expires every ~72 days → rotation reminders) |
| Apple | App Store Connect .p8 key + Key ID + Issuer ID (App Manager role) |

Chrome intentionally skips OAuth entirely — the Web Store API v2 (the v1.1
API it replaces sunsets 2026-10-15) authenticates with a GCP service account,
which needs no consent-screen review and has no refresh token to expire. The
tenant creates a service account, downloads its JSON key, and adds the
service account's email as a collaborator on their Chrome Web Store developer
account.

## Reconciliation loop

Every 30 minutes (Cron Trigger) `apps/api/src/reconcile/run.ts` compares each
enabled `(extension, store)` target's latest artifact against the store's
actual state and submits, withdraws-then-submits, or blocks — see spec §3.1–3.2
and Appendix A for the policy. `apps/api/src/reconcile/decide.ts` is the pure
decision core (fully unit tested); `mergeState()` there encodes the contract
every `StoreAdapter.getState()` follows: an explicit `null` field means the
store *confirmed* nothing is live/pending, an *omitted* field means the store
can't tell us at all (Edge always omits both — it has no status-query
endpoint) and the reconciler must keep whatever it last knew instead of
overwriting real state with a false "nothing here."

Trigger a reconcile early instead of waiting for the next tick — e.g. right
after a CI push — with `POST /v1/extensions/:id/reconcile` (session or API key).

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
