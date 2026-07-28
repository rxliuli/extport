# Licensing (design)

Status: **slices A + B accepted** (2026-07-28). A: real activation from
substack-exporter's dev build against production. B: a Stripe test-mode
Payment Link purchase fulfilled end-to-end — signature-verified webhook →
issued license → emailed code that activates against the public wire
protocol. Slice C implemented the same day (portal pages, tenant
licensing UI, portal.extport.dev); its acceptance — a real
checkout-redirect showing the code, and a magic-link round trip — is
pending deploy.
Predecessor: [license-kit](https://github.com/rxliuli/license-kit)
(store.rxliuli.com), which has run this exact model in production for the
author's paid extensions. Its data will be imported; its client storage
contract is inherited unchanged.

## The model in one sentence

The server is the only source of truth: devices activate online, re-check
online when they can, and cache the resulting entitlement locally — no
client-side cryptography of any kind.

## Why no offline / signed verification

The original Phase 2 sketch said "offline verification (Ed25519)". Dropped
deliberately: every client-side check runs inside code the user can read
and patch. A signed receipt only defends against storage tampering, but
anyone who can edit storage can edit the extension code that checks the
signature — in the extension threat model a signature buys nothing real.
license-kit has shipped the unsigned online model to real buyers without
incident, which settles it empirically.

Consequences: the `tenant_signing_keys` table is dropped, `@extport/sdk`
is a thin fetch + storage client, and there is no WebCrypto compatibility
question at all. The README's Phase 2 blurb gets rewritten when this lands.

## What license-kit proves — and what it lacks

Proven, inherited as-is: the two-endpoint wire model (activate / check),
`crypto.randomUUID()` as the device fingerprint (no real fingerprinting —
a reinstall is a new seat by design), refund/dispute webhooks as the only
revocation path, check-as-heartbeat (`lastSeenAt` updated on every online
touch), the buyer magic-link portal, and the client's local storage format.

Fixed in extport:

- **Multi-tenancy** — license-kit is single-owner; extport scopes
  everything by tenant.
- **No seat decay** — license-kit devices only accumulate; with random
  UUID fingerprints, seats eventually exhaust. extport releases idle seats
  (below).
- **Tier lives on codes, not plans** — license-kit snapshots
  `planTier` onto each code with no catalog behind it. extport models
  plans explicitly (below).
- **`Math.random()` codes** — license-kit's generator is not
  cryptographically random. extport generates the same visual format
  (`XXXX-XXXX-XXXX-XXXX`, 32-char alphabet without I/O/0/1) from
  `crypto.getRandomValues`. Imported codes stay valid verbatim — only
  generation changes.
- **Denormalized `activeDevices` counter** — drift-prone double
  bookkeeping. extport counts active activation rows instead.

## Public wire protocol

Two unauthenticated endpoints. This contract is simultaneously the SDK's
API and the fleet-migration compatibility layer — change it only with a
reason strong enough to break both.

```
POST /api/v1/licensing/activate   { code, productName, fingerprint, deviceInfo? }
  → { success, message, data?: { tier, expiresAt: null } }

POST /api/v1/licensing/check      { code, productName, fingerprint }
  → { success, data?: { isActive, tier, expiresAt: null } }
```

- **No tenant in the URL.** Codes are globally unique; a code resolves
  license → plan → extension → tenant. `productName` is a cross-check
  (the extension asking must name the product the code was sold for), not
  a lookup key. Brute-force defense is code entropy (80 bits), same as
  license-kit.
- **`productName` is checked against `extensions.name`, which is frozen
  while licensing is enabled.** A display-form string is doing a
  machine-key job only because license-kit's wire and data froze it
  ('Substack Exporter'), and the dual-backend cascade must keep sending
  it either way — so rather than duplicating that string onto plans,
  the extension's own name carries it and its PATCH is rejected while
  `licensingEnabled` (an honest freeze: the coupling exists whether or
  not we acknowledge it). The end-state key is the immutable, opaque
  **`extensionId`** — the retirement step switches to it and lifts the
  name freeze for good.
- **`check` is the heartbeat.** There is no separate heartbeat endpoint.
  Both endpoints refresh the activation's `lastHeartbeatAt`, but only
  write when the stored value is older than 12 h — otherwise every
  browser start becomes a D1 write.
- **Public host: `api.extport.dev`** (the SDK's default `apiBase`), even
  though it's the same Worker as dash.extport.dev. The default apiBase
  gets baked into installed extension binaries with weeks-to-forever
  update lag, making it the least-changeable contract in the system — it
  must not be coupled to a UI hostname that may be restructured. Same
  pattern as api.stripe.com / api.keygen.sh et al.
- **CORS `origin: '*'` on these routes only.** They carry no cookies or
  credentials, so `*` costs nothing — and without it, every tenant's
  extension would need `host_permissions` for our host just to verify
  licenses (Chrome bypasses CORS only with that grant; on Firefox/Safari
  the grant is user-revocable and not always given). The rest of the API
  stays same-origin with no CORS at all.
- **`expiresAt` is emitted as `null`** (perpetual has no expiry) but
  tolerated on the client when reading stored state — imported license-kit
  records carry `dayjs().add(100, 'year')` values that must keep parsing.
- Endpoints 404 unless the plan's extension has `licensingEnabled`.

## Entitlements: perpetual only

All of the author's paid extensions are one-time purchases; v1 implements
only `perpetual`. The `entitlementType` enum keeps its other values
(TS-level only, no DB constraint) but no code path reads them. The
`licenses.balance` column is dropped — re-add it when a balance plan
actually exists. Licenses have no `expiresAt` column.

## Schema deltas

All licensing tables are empty in production, so this restructuring is
one cheap migration with zero data concerns.

| Table | Change |
|---|---|
| `plans` (né `products`) | + `tier` (text). One row per (extension, tier). Plans have **no name**: the SDK's `productName` is checked against `extensions.name` (0019 dropped the short-lived `plans.name` — one entity, one key). Renamed products → plans (2026-07-28): "product" collides with Stripe/Paddle's Product and Edge's Partner Center Product ID, while the SDK (`plans`, `usePlan`), the buyer UI ("Current Plan"), and license-kit (`planTier`) already speak *plan*. − `stripeMetadataKey`: the metadata key is fixed (`extport_plan`), its value is the plan id. |
| `licenses` | + `maxActivations` snapshot at issuance (plan edits must not retroactively change sold licenses). − `balance`. Unique index on `sourceRef` (webhook idempotency + refund lookup). Status: `active / locked / refunded`. |
| `activations` | Unique index on (`licenseId`, `deviceFingerprint`); re-activation of a known fingerprint reuses the row (clears `releasedAt`). A seat is an activation with `releasedAt IS NULL`. |
| `license_events` | Enum becomes `issued / activated / seat_released / revoked / reset`. Heartbeats are not events. |
| `tenant_signing_keys` | Dropped. |
| `payment_credentials` (new, slice B) | (tenantId, provider `'stripe'`, encrypted webhook secret, keyVersion) — same envelope encryption as store credentials. One Stripe account per tenant. |
| `magic_links`, `buyer_sessions` (new, slice C) | Buyer identity is just an email (licenses already carry `buyerEmail`; no profile table until something needs one); magic links are the only buyer auth. |
| `licenses.checkoutSessionId` (new, slice C) | Stripe Checkout Session id (cs_…), stored at fulfillment for the success page's time-boxed lookup; `sourceRef` remains the PaymentIntent for refunds. |

## Seat decay — lazy, no cron

Seats are only scarce at the moment a new device asks for one. When
activation hits the `maxActivations` limit, first release every seat whose
`lastHeartbeatAt` is older than 30 days (emitting `seat_released`), then
recount and accept or reject. No scheduled job, no configuration knob. A
buyer who reinstalls their browser occupies a fresh seat and the old one
decays — expected behavior, not a bug.

## Revocation and staleness

Revocation has exactly one trigger: a `charge.refunded` /
`charge.dispute.created` webhook flips the license to `refunded` (event:
`revoked`). It propagates on the device's next successful `check`, which
clears the cached local state.

The client **never self-degrades a perpetual entitlement on staleness**.
A legitimate buyer offline for six months keeps their features; a refunded
buyer keeps them until they next come online. Punishing the former to
inconvenience the latter is a bad trade. The SDK re-checks on extension
startup — no client-side throttle: startups are already rare, the server's
12 h heartbeat-write throttle absorbs the writes, and a check read costs
nothing worth a persisted timestamp.

## Plans gate issuance — never validation

The tenant's subscription to extport pays for *creating* things:
publishing quota, plans, issuing new licenses. It never pays for
keeping already-issued licenses verifiable. When a tenant downgrades,
churns to free, or walks away entirely, `activate`/`check` for every
license they ever issued keeps serving indefinitely — validation traffic
is a rounding error in cost, and the alternative (buyers' paid features
dying because their developer stopped paying us) is the worst outcome a
licensing platform can produce.

Graceful shutdown of a single extension is **dormancy, not deletion**:
flip `licensingEnabled` off (and disable publish targets). New
activations stop (404); already-activated devices keep their entitlement
forever, because the SDK clears local state only on a definitive
rejection — a 404 is a thrown error, not a verdict. DELETE on an
extension stays hard-blocked while issued licenses exist.

The same property is the platform-death safety net: if extport itself
ever disappears, every activated device keeps working from cached state.
The failure mode of this design is always "no *new* activations", never
"paid features turn off".

## BYO-Stripe (slice B)

The tenant's own Stripe account; extport never touches money. The
zero-code tenant story:

1. Create a Payment Link in the Stripe dashboard, set metadata
   `extport_plan = <plan id>`.
2. Point a Stripe webhook (`checkout.session.completed`,
   `charge.refunded`, `charge.dispute.created`) at
   `POST /api/v1/licensing/webhooks/stripe/:tenantId`, store the signing
   secret in extport.

Fulfillment: verify signature → dedupe by `sourceRef` (payment intent id,
falling back to session id for 100%-discount zero-total sessions, as
license-kit does) → resolve plan from metadata → issue license with the
buyer email from `customer_details` → email the code (extport.dev sending
domain is already onboarded).

Storing a Stripe webhook secret is philosophically identical to storing
store credentials — same vault, same mental model. The line extport does
not cross is merchant-of-record (tax/compliance burden — that is
Paddle/LemonSqueezy's moat, not ours). Stripe Connect (hosted checkout on
the tenant's behalf) is a possible later value layer; the `source` enum
already leaves room and nothing in this design blocks it.

## SDK (`@extport/sdk`)

The successor to `@rxliuli/activation-client`, inheriting its client-side
contract exactly: `PlanConfig { code, tier, expiresAt, fingerprint }`
stored under the `plan` key (idb-keyval default adapter), a `plans` table
that must include `free`, unknown tiers resolving to free, and the
`override()` dev hook. Fleet extensions swap the import and the `apiBase`;
existing users' local state is taken over in place.

One behavior is new relative to activation-client: **when `check` reports
the device as not activated but a local config exists, the SDK does not
clear state — it re-runs `activate` with the stored code + fingerprint,
and only clears when that also fails** (the code is genuinely revoked, or
the seat limit is full of other live devices). activation-client cleared
immediately, which is too eager: this rule is the self-healing return path
for a seat released by decay, and it is what makes the gradual fleet
migration's mixed-version window safe (below).

During the migration window the **default backend list is a cascade**:
extport first, then license-kit (store.rxliuli.com), the second consulted
only when a code is definitively rejected upstream — valid extport codes
never touch it, so the legacy hop carries only pre-cutover codes and
typos. `apiBase` is a dev/self-host override (single backend, no
cascade). Clearing local state requires a definitive rejection **from
every backend**; network failures and 5xx are expected states and never
revoke anything. One wire nuance the cascade absorbs: license-kit's
rejections arrive as HTTP 4xx with a JSON body (not 200 +
`success: false`), which counts as definitive. The legacy entry is
removed in a release after license-kit retires.

## Fleet migration (license-kit → extport) — per product, gradual

**Hard rule: no existing paying user may be harmed. Nobody re-enters a
code, nobody loses features, no purchase fails to fulfill.** Every
ordering decision below exists to preserve this.

There is no big-bang cutover. The unit of migration is **one product**,
because all three dimensions switch independently:

- **Data** — the import filters by `productName`; one product at a time.
- **Client** — each extension releases its `@extport/sdk` version on its
  own schedule.
- **Sales** — Stripe allows multiple webhook endpoints on one account
  (each with its own signing secret), so license-kit's and extport's
  endpoints coexist for the whole transition. The fleet historically
  sells through license-kit's own checkout endpoint (API-created
  sessions stamping `product_name`/`tier` metadata read from the
  price) — but that endpoint is a hand-written Payment Link: it wraps
  a static priceId with static metadata and nothing else. So the
  migration moves each **plan onto a real Payment Link** (one link per
  plan: metadata `extport_plan`, promotion codes enabled, confirmation
  message pointing at the email). Single-tier extensions deep-link
  from their upgrade button straight to Stripe checkout — strictly
  fewer clicks than the storefront hop. Multi-tier stays backend-free
  too: a chooser is inherent to selling two things, and it can be
  static per-tier links in the extension's own plan dialog (whose
  `plans` table already knows the tiers) or a Stripe pricing-table
  embed. Storefront buy buttons become static hrefs (pages stay for
  SEO); license-kit's checkout endpoint retires with the last plan,
  and tenant zero lands on the exact zero-code path recommended to
  every other tenant. The one license-kit patch shipped up front: its
  webhook skips sessions carrying `extport_plan` (both endpoints
  receive all events during coexistence). Refund events are safe to deliver to both: each side acts
  only on its own DB, and license-kit revoking its stale copy of a
  migrated license is a no-op in practice.

Per-product cutover sequence — **client first, server at leisure**. The
SDK's default backend list is a cascade (extport, then license-kit,
consulted only on definitive rejection — see the SDK section), which
decouples the extension rollout from every server-side step. Sequencing
principle: the store-review clock is the only uncontrollable step in the
whole migration, so it starts first.

1. **Ship the extension on the dual-backend `@extport/sdk`.** Behavior
   today is unchanged (all codes still resolve via the license-kit
   fallback); the capability to recognize extport codes is now riding
   the review + auto-update pipeline.
2. **Once the rollout saturates** (store version stats), flip the sale:
   create the plan's Payment Link and repoint the buy buttons
   (storefront href; extension upgrade button already deep-links). New
   sales fulfill in extport; dual clients activate them on the first
   hop. The residual gap is only installs still on a pre-dual version —
   its size is chosen by picking the flip date, not dictated by review
   queues.
3. **Run the import whenever convenient.** With the cascade, old codes
   and old devices keep resolving via the fallback — the import no
   longer gates the flip or the release; it gates only license-kit's
   retirement (and carries `sourceRef` so old Stripe-era refunds keep
   revoking after the storefront webhook goes away).
4. **Retire license-kit last**, then ship a post-retirement SDK release
   that drops the legacy cascade entry (until then, a mistyped code
   after retirement degrades from "invalid" to a retryable error —
   cosmetic, and only on the typo path). **The same release switches the
   identity key from `productName` to `extensionId`**: the SDK config
   takes the opaque `ext_…` id (copied from the dashboard, same gesture
   as `plan_…` into Stripe metadata), extport's activate/check prefer
   `extensionId` and keep accepting `productName` for the installed
   long tail, and the `extensions.name` freeze lifts — display names go
   back to being display-only, permanently.

Buyer-portal gap: codes sold post-flip don't appear in the old
store.rxliuli.com portal — extport's portal is slice C. So high-volume
products flip after C ships; low-volume products flip after B. license-kit
is decommissioned only after the last product flips.

Import mapping, `source: 'imported'`:

| license-kit | extport |
|---|---|
| `activation_code.code` | `licenses.key` — **verbatim** |
| `activation_code.planTier` + `productName` | resolve/create `plans` row (extension, tier) |
| `activation_code.maxDevices` | `licenses.maxActivations` |
| `activation_code.status` (`active/revoked/expired`) | `active` / `refunded` / `refunded` |
| `user.email` | `licenses.buyerEmail` (denormalized; `buyers` row in slice C) |
| `payment.providerTransactionId` | `licenses.sourceRef` |
| `device.fingerprint` | `activations.deviceFingerprint` |
| `device.lastSeenAt` | `activations.lastHeartbeatAt` |

**Acceptance criterion (hard): a device activated under license-kit
passes `check` against extport without re-activation. No buyer ever
re-enters a code.** The 100-year `expiresAt` values live only in clients'
local storage and remain valid there; the server stops emitting them.

## Slices

- **A — core loop.** Schema restructure, `activate`/`check`, manual
  license issuance (dashboard/API), `@extport/sdk`. Done when one real
  fleet extension activates a hand-issued code end-to-end against extport.
- **B — money.** `payment_credentials`, Stripe webhook, fulfillment
  email. Done when a Stripe test-mode purchase lands a working code in an
  inbox.
- **C — self-service.** Buyer-facing surface on **portal.extport.dev**
  (same Worker, third hostname — like api.*, these URLs get baked into
  long-lived external config: Payment Link redirects and emails):
  - **Checkout success page**: Payment Links redirect to
    `/purchase/success?session_id={CHECKOUT_SESSION_ID}`. The page polls
    a public endpoint that resolves the session id to the fulfilled
    license — the redirect always beats the webhook, so polling is the
    wait, and only signature-verified webhook writes are ever shown.
    Fulfillment stores `licenses.checkoutSessionId` (cs_… for the
    success page; `sourceRef` stays the pi_… for refunds) because
    extport holds no tenant API key to resolve cs → pi the way
    license-kit could with its own account key. The lookup expires 24 h
    after purchase (the session id rides in a URL — history-leak-proof
    it with a window), after which the page points at the email and the
    portal.
  - **Buyer portal, read-only**: magic-link sign-in by email
    (`magic_links` + `buyer_sessions`; identity is just the email —
    no buyers profile table until something needs one), listing every
    license under that buyerEmail with its devices. **No self-service
    seat release**: lazy decay already frees honest idle seats, and a
    release button would invite one-code-infinite-devices rotation.
    Edge cases go through the tenant.
  - **Tenant dashboard licensing UI** (dash.extport.dev): plans and
    licenses on the extension page following the "Add a store" top-right
    button convention; the create-plan form prefills name = extension
    name, tier = `pro`, 3 activations (prefill is a suggestion the
    tenant confirms — never an auto-created row). Includes the manual
    seat release / reset control (the `reset` event) that the buyer
    portal deliberately lacks.

Rollout rhythm against the migration: after A, dogfood one low-stakes
extension with a hand-issued code (no sales flip). After B, start flipping
low-volume products through the per-product sequence above. After C, flip
the high-volume products, then decommission license-kit.

## Boundaries deliberately kept out

- **No hosted storefront.** license-kit bundles store.rxliuli.com;
  extport does not become a store. Tenants sell from their own pages via
  Payment Links.
- **No merchant-of-record, no subscriptions, no balance entitlements** in
  v1 (enum room reserved).
- **No client-side cryptography, no device fingerprinting** beyond the
  self-assigned random UUID.
