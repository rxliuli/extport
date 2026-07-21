# extport

Browser extension publishing & licensing platform. Multi-tenant SaaS on Cloudflare
Workers + D1 + R2; the author is "tenant zero" and uses the exact same code paths
as external tenants.

Two independent per-extension modules:

- **Publishing** (Phase 1, in progress) — reconciliation-loop based store publishing
  (Chrome / Firefox / Edge / Safari), latest-wins versioning, status matrix, notifications.
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
pnpm --filter @extport/dashboard dev # dashboard on :5173, proxies /api to :8787
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
| Safari | App Store Connect .p8 key + Key ID + Issuer ID (App Manager role) |

Chrome intentionally skips OAuth entirely — the Web Store API v2 (the v1.1
API it replaces sunsets 2026-10-15) authenticates with a GCP service account,
which needs no consent-screen review and has no refresh token to expire. The
tenant creates a service account, downloads its JSON key, and adds the
service account's email as a collaborator on their Chrome Web Store developer
account.

## Reconciliation loop

`deployment_versions` holds one row per `(extension, store, version)` ever
pushed. Its `status` moves in place through a single lifecycle instead of
being reconstructed from a separate event log:

```
queued ──submit succeeds──▶ in_review ──store confirms live──▶ online
  │                            │
  │                            └──store rejects──▶ rejected
  │
  └──superseded by a newer push, or already older than what's
     live/in-review at push time──▶ skipped
```

At most one `queued` and one `in_review` row may be active per
`(extension, store)` at a time — that invariant is enforced on the write
path, not by a DB constraint:

- **Pushing an artifact** (`POST /api/v1/artifacts`) rejects outright (409) if the
  version isn't strictly newer than whatever's already queued/in-review/live
  for its target store(s) — no silent "accepted but ignored". Otherwise it
  marks any existing `queued` row `skipped` (an `in_review` row is never
  touched — see below) and inserts the new one as `queued`.
- **Adding a store target** backfills any artifact pushed before the target
  existed to receive it, using the same logic.
- Either action then triggers a scoped reconcile immediately
  (`ctx.waitUntil`) instead of waiting for the next cron tick.

`apps/api/src/reconcile/run.ts`'s `reconcileOne` then does two things per
tick, per target: **resolve** (reflect whatever `StoreAdapter.getState()`
reports this tick onto the active `in_review` row — online, rejected, or a
previously-unknown in-review version discovered as a baseline) and **decide**
(`apps/api/src/reconcile/decide.ts`, pure and fully unit tested — just two
booleans, `hasQueued` and `stillInReview`, since version ordering is already
guaranteed by the write path). No auto-withdraw: an in-review row is never
cancelled to make room for a newer queued one — that livelocks on stores
whose review latency exceeds the push cadence (Edge's ~week-long queue), since
every tick would reset the review clock and nothing would ever finish.

`getState()`'s contract: an explicit `null` field means the store *confirmed*
nothing is live/pending, an *omitted* field means the store can't tell us at
all (Edge always omits both — no status-query endpoint) and the reconciler
must leave the row alone instead of overwriting real state with a false
"nothing here."

The Cron Trigger runs this every 30 minutes with no filter. Trigger it early
instead of waiting for the next tick with `POST /api/v1/extensions/:id/reconcile`
(session or API key) — though in practice a push or a new target already does
this automatically.

## Notifications

Email only for now — Telegram/Discord are deferred (the `Notifier` interface
in `apps/api/src/lib/notify.ts` is already channel-agnostic, so adding one
later is a new adapter, not a redesign). Sent via Cloudflare's native
[Email Sending](https://developers.cloudflare.com/email-service/) Workers
binding (`env.EMAIL`, configured as `send_email` in `wrangler.jsonc`) — no
third-party vendor. The `from` domain must be onboarded once with
`wrangler email sending enable yourdomain.com`; set `NOTIFICATION_FROM_EMAIL`
to an address on that domain.

Submitted/approved/rejected fire an email inline whenever `reconcileOne`
transitions a `deployment_versions` row — they aren't persisted as their own
event (the row's status *is* the record); `error`/`recovered`/`stale_review`
are the only `publish_events` types left, since they're the only things that
aren't about one specific version. `error` and `recovered` are **transition
markers**, never per-tick records: entering the error state records one
event and sends one email, every further failing tick only refreshes
`publish_targets.lastErrorDetail` (so a credential left broken for a week is
one email, not 48 a day from the half-hourly cron), and the next successful
tick closes the story with a `recovered` event (audit only, no email —
whoever fixed it already knows). `rejected`/`error` are the urgent tier,
`approved`/`submitted` are routine, `stale_review` is a once-per-day digest
(deduped by the same 20-hour window that already gates the event itself, see
M3). Entering `queued` or `blocked` (waiting behind an in-review row) is
deliberately silent — steady state, not worth an email; check the dashboard
Versions matrix for that. Credential expiry is a separate check
(`apps/api/src/reconcile/expiry.ts`, also run
every cron tick): one advance-warning email exactly on the `active` →
`expiring` transition — a deliberate simplification of the spec's 30/7/1-day
reminder ladder, since the natural `error` notification once a credential
actually fails already covers the "after" side without extra state tracking.

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
wrangler email sending enable yourdomain.com   # for notification emails
wrangler secret put KEK_V1            # openssl rand -base64 32
wrangler secret put GITHUB_CLIENT_SECRET
pnpm db:migrate:remote
pnpm deploy
```
