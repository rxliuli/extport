# Licensing (design)

Status: **slices A + B + C accepted**. A: real activation from
substack-exporter's dev build against production (2026-07-28). B: a
Stripe test-mode Payment Link purchase fulfilled end-to-end —
signature-verified webhook → issued license → emailed code that
activates against the public wire protocol (2026-07-28). C: portal
pages, tenant licensing UI, portal.extport.dev, deployed and accepted
— checkout-redirect showing the code and the magic-link round trip
both verified live; the whole fleet's payment/licensing migration is
complete (`migration-status.md`).
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
question at all. (Done — the README no longer carries a Phase 2 blurb.)

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

Two unauthenticated endpoints. This contract is the SDK's API; the old
`productName` identity and its license-kit cascade were retired with the
fleet migration (see Fleet migration below).

```
POST /api/v1/licensing/activate   { code, extensionId, fingerprint, deviceInfo? }
  → { success, message, data?: { tier, expiresAt: null } }

POST /api/v1/licensing/check      { code, extensionId, fingerprint }
  → { success, data?: { isActive, tier, expiresAt: null } }
```

- **No tenant in the URL.** Codes are globally unique; a code resolves
  license → plan → extension → tenant. `extensionId` is a cross-check
  (the caller must prove it is the extension the code was sold for), not
  a lookup key. Brute-force defense is code entropy (80 bits), same as
  license-kit.
- **Identity is the immutable `ext_…` id.** `extensionId` is compared
  against the extension the code resolves to. The pre-0.0.7 SDK's
  `productName` identity was retired with the fleet migration (2026-08):
  names are display-only, and the old `extensions.name` freeze lifted
  with it — a rename can no longer fail any device's check.
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

## Two separated models: Licenses vs Subscriptions

extport cleanly separates two distinct billing & fulfillment models:

- **Licenses (`licenses` + `activations` + `license_events`) — one-time `perpetual` activation codes**:
  - Fulfilled by `checkout.session.completed` (`mode: 'payment'`) into `licenses`, generating an activation code (`XXXX-XXXX-XXXX-XXXX`) and emailing it to the buyer.
  - Verified by end-user extension devices via `POST /api/v1/licensing/activate` and `POST /api/v1/licensing/check` (`@extport/sdk`), with seat limits (`maxActivations`) and lazy 30-day seat decay.
  - Managed Checkout: `POST /api/v1/licensing/checkout` creates a one-time Stripe Checkout Session (`mode: 'payment'`) for a `perpetual` plan.
  - Revoked only on `charge.refunded` / `charge.dispute.created`.
  - Shown in the Buyer Portal (`portal.extport.dev`) and the dashboard's **Licenses** table.
- **Subscriptions (`subscriptions` + `subscription_events`) — account-based `recurring` billing**:
  - Fulfilled by `checkout.session.completed` (`mode: 'subscription'`) into `subscriptions` (`esub_…`) — **no activation key is generated and no activation-code email is sent**.
  - Pricing, intervals (monthly/yearly), free trials, coupons, and customer self-service stay in Stripe. extport tracks `status` (`trialing` / `active` / `past_due` / `canceled` / `expired`), `currentPeriodStart`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `externalUserId` (from `client_reference_id`), and `stripeCustomerId`.
  - Dedicated tenant API under `/api/v1/subscriptions`:
    - `GET /api/v1/subscriptions` — list subscriptions (filterable by `?extension=`, `?status=`, `?search=`, keyset-paginated via `?limit=` & `?before=`).
    - `GET /api/v1/subscriptions/entitlements` — server-side entitlement check by `extensionId` + (`externalUserId` or case-insensitive `email`). Returns `{ active, tier, subscriptionId, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd }`.
    - `POST /api/v1/subscriptions/checkout` — duplicate-subscription-guarded Checkout Session creation. Reuses any existing `stripeCustomerId` under the tenant; if the user already has an entitled subscription for `(tenantId, extensionId)`, creates a Stripe Billing Portal session and returns `200 { action: 'portal', url, reason: 'already_subscribed' }` (or `409` if no `stripeCustomerId` exists).
    - `POST /api/v1/subscriptions/portal` — creates a one-click Stripe Billing Portal session for `{ extensionId?, externalUserId?, email?, returnUrl }`.
  - Shown in the dashboard's dedicated **Subscriptions** table (no key column, no device seats).
- Each extension picks one mutually exclusive `billingMode` (`'license'` for one-time `perpetual` plans or `'subscription'` for `recurring` plans), editable until the first plan is created. `maxActivations` applies only to `perpetual` plans (`0` / hidden in UI for `recurring` plans).

### Subscription Stripe webhook lifecycle

Point the tenant's Stripe webhook (`POST /api/v1/licensing/webhooks/stripe/:tenantId`) at:

- `checkout.session.completed` (and `checkout.session.async_payment_succeeded`) — routes `recurring` plans to `subscriptions` + `subscription_events` (`created`) and `perpetual` plans to `licenses` + `license_events` (`issued`) + activation email. Returns 500 on plan/mode mismatch so misconfigured links fail loudly.
- `customer.subscription.created` / `customer.subscription.updated` — syncs `status`, `currentPeriodStart`, `currentPeriodEnd`, `cancelAtPeriodEnd`, and `stripeCustomerId` on `subscriptions`. Supports both legacy top-level period fields and Stripe API 2025-03-31+ `items.data[0].current_period_start/end`.
- `customer.subscription.deleted` — marks `status = 'expired'` (immediately ending entitlement even when canceled mid-period).
- `invoice.paid` — updates period dates from `lines.data[].period` and marks status `'active'` (preserving `'trialing'` on initial $0 trial invoices), logging `renewed` on renewal cycles. Supports both top-level `invoice.subscription` and Stripe API 2025-03-31+ `invoice.parent.subscription_details.subscription`.
- `invoice.payment_failed` — marks `status = 'past_due'` (grace period remains entitled while Stripe retries).
- `charge.refunded` / `charge.dispute.created` — revokes `perpetual` licenses only; subscriptions are managed through the subscription lifecycle above.

**Out-of-order resilience:** `checkout.session.completed` omits period dates while `customer.subscription.*` and `invoice.*` events omit `buyerEmail` and `client_reference_id`. Events arriving before `checkout.session.completed` are staged in `pending_stripe_subscriptions` keyed by `(tenantId, sub_…)` and merged when `checkout.session.completed` inserts the `subscriptions` row.

### Subscription entitlement rules

A subscription is currently entitled (`isSubscriptionEntitled`) when `status` is `'active' | 'trialing' | 'past_due'`, OR (`status === 'canceled'` AND `currentPeriodEnd > now`). When multiple subscriptions match a user/email lookup, `pickBestSubscription` prefers entitled over inactive, then higher status rank (`active > trialing > past_due > canceled`), furthest `currentPeriodEnd`, newest `createdAt`.

## Lightweight Stripe control plane (Restricted Key)

Store a **Stripe Restricted Key** (`rk_…`) alongside `webhookSecret` in `payment_credentials` (Settings → Stripe). Minimal required Stripe Restricted Key permissions: **Products**, **Prices**, **Customers**, **Checkout Sessions**, and **Customer Portal** (Write).

- **Credential merging (`POST /api/v1/payment-credentials`)**: `encryptedPayload` holds `{ webhookSecret?, apiKey? }`, `hint` holds `webhookSecret` last 4 (`''` if unset), and `apiKeyHint` holds `apiKey` last 4. Updating either secret preserves the other.
- **Plan → Stripe Product / Price sync (`POST /api/v1/plans`, `PATCH /api/v1/plans/:id`)**: Plans carry optional `currency`, `amount` (`perpetual`), `monthlyAmount` / `yearlyAmount` (`recurring`), and `stripeProductId` / `stripePriceId` / `stripeMonthlyPriceId` / `stripeYearlyPriceId`. When amounts are supplied without manual price IDs, extport creates the Stripe Product (`${extension.name} (${tier})`, metadata `extport_extension`, `extport_plan`, `extport_tier`) and Price(s). On price updates, extport creates a new Stripe Price and best-effort archives the previous Price.
- **Checkout & Billing Portal**:
  - Subscriptions: `POST /api/v1/subscriptions/checkout` (duplicate-guarded) and `POST /api/v1/subscriptions/portal`.
  - One-time licenses: `POST /api/v1/licensing/checkout` (`mode: 'payment'`).

## Schema deltas

All licensing tables are empty in production, so this restructuring is
one cheap migration with zero data concerns.

| Table                                          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans` (né `products`)                        | + `tier` (text). One row per (extension, tier). Plans have **no name**: the extension (ext_… id) is their identity (0019 dropped the short-lived `plans.name`). Renamed products → plans (2026-07-28): "product" collides with Stripe/Paddle's Product and Edge's Partner Center Product ID, while the SDK (`plans`, `usePlan`), the buyer UI ("Current Plan"), and license-kit (`planTier`) already speak _plan_. − `stripeMetadataKey`: the metadata key is fixed (`extport_plan`), its value is the plan id. |
| `licenses`                                     | + `maxActivations` snapshot at issuance (plan edits must not retroactively change sold licenses). − `balance`. Unique index on `sourceRef` (webhook idempotency + refund lookup). Status: `active / locked / refunded`.                                                                                                                                                                                                                                                                                         |
| `activations`                                  | Unique index on (`licenseId`, `deviceFingerprint`); re-activation of a known fingerprint reuses the row (clears `releasedAt`). A seat is an activation with `releasedAt IS NULL`.                                                                                                                                                                                                                                                                                                                               |
| `license_events`                               | Enum becomes `issued / activated / seat_released / revoked / reset`. Heartbeats are not events.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tenant_signing_keys`                          | Dropped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `payment_credentials` (new, slice B)           | (tenantId, provider `'stripe'`, encrypted webhook secret, keyVersion) — same envelope encryption as store credentials. One Stripe account per tenant.                                                                                                                                                                                                                                                                                                                                                           |
| `magic_links`, `buyer_sessions` (new, slice C) | Buyer identity is just an email (licenses already carry `buyerEmail`; no profile table until something needs one); magic links are the only buyer auth.                                                                                                                                                                                                                                                                                                                                                         |
| `licenses.checkoutSessionId` (new, slice C)    | Stripe Checkout Session id (cs_…), stored at fulfillment for the success page's time-boxed lookup; `sourceRef` remains the PaymentIntent for refunds.                                                                                                                                                                                                                                                                                                                                                           |

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

The tenant's subscription to extport pays for _creating_ things:
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
The failure mode of this design is always "no _new_ activations", never
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

> Operational checklist with the verified commands and pitfalls:
> [`migration-runbook.md`](migration-runbook.md).

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

   **Status: shipped.** The SDK switched on 2026-08-01 (0.0.7; the whole
   fleet is on 0.0.8/0.0.9 since 2026-08-05). With no shipped build left
   on `productName`, the server's wire-compat fallback was retired
   2026-08-20: activate/check now require `extensionId` (a pre-0.0.7
   client gets a 400), and the `extensions.name` freeze is gone.

Buyer-portal gap: codes sold post-flip don't appear in the old
store.rxliuli.com portal — extport's portal is slice C. So high-volume
products flip after C ships; low-volume products flip after B. license-kit
is decommissioned only after the last product flips.

Import mapping, `source: 'imported'`:

| license-kit                                         | extport                                                       |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `activation_code.code`                              | `licenses.key` — **verbatim**                                 |
| `activation_code.planTier` + `productName`          | resolve/create `plans` row (extension, tier)                  |
| `activation_code.maxDevices`                        | `licenses.maxActivations`                                     |
| `activation_code.status` (`active/revoked/expired`) | `active` / `refunded` / `refunded`                            |
| `user.email`                                        | `licenses.buyerEmail` (denormalized; `buyers` row in slice C) |
| `payment.providerTransactionId`                     | `licenses.sourceRef`                                          |
| `device.fingerprint`                                | `activations.deviceFingerprint`                               |
| `device.lastSeenAt`                                 | `activations.lastHeartbeatAt`                                 |

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
