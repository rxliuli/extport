# Licensing (design)

Status: **slices A + B accepted** (2026-07-28). A: real activation from
substack-exporter's dev build against production. B: a Stripe test-mode
Payment Link purchase fulfilled end-to-end — signature-verified webhook →
issued license → emailed code that activates against the public wire
protocol. Slice C not started.
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
| `plans` (né `products`) | + `tier` (text). One row per (extension, tier); `name` is the app-level name shared across tiers ("IMP Translate" basic + pro are two rows, same name) and is what the SDK sends as `productName` — that wire field name is frozen, the table is not. Renamed products → plans (2026-07-28): "product" collides with Stripe/Paddle's Product and Edge's Partner Center Product ID, while the SDK (`plans`, `usePlan`), the buyer UI ("Current Plan"), and license-kit (`planTier`) already speak *plan*. − `stripeMetadataKey`: the metadata key is fixed (`extport_plan`), its value is the plan id. |
| `licenses` | + `maxActivations` snapshot at issuance (plan edits must not retroactively change sold licenses). − `balance`. Unique index on `sourceRef` (webhook idempotency + refund lookup). Status: `active / locked / refunded`. |
| `activations` | Unique index on (`licenseId`, `deviceFingerprint`); re-activation of a known fingerprint reuses the row (clears `releasedAt`). A seat is an activation with `releasedAt IS NULL`. |
| `license_events` | Enum becomes `issued / activated / seat_released / revoked / reset`. Heartbeats are not events. |
| `tenant_signing_keys` | Dropped. |
| `payment_credentials` (new, slice B) | (tenantId, provider `'stripe'`, encrypted webhook secret, keyVersion) — same envelope encryption as store credentials. One Stripe account per tenant. |
| `buyers`, `magic_links` (new, slice C) | Buyer identity is a tenant-scoped email; magic links are the only buyer auth. |

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

Per-product cutover sequence:

1. **Flip the sale: create the plan's Payment Link and repoint the buy
   buttons at it** (storefront href now; the extension's own upgrade
   button with its next release). New sales fulfill in extport — the
   skip patch above keeps license-kit's webhook from hitting its
   "missing fulfillment data" throw → 500 → retry noise.
2. **Run the import for that product.** Because the flip happened first,
   the import covers every code sold pre-flip and every code sold
   post-flip is extport-native — no code can fall between.
3. **Release the extension version on `@extport/sdk`.**
4. **Wait out the mixed-version window** (store review + browser
   auto-update lag; weeks). Old clients keep working against license-kit
   — its data is never deleted. Devices they activate there during the
   window are unknown to extport and self-heal via the SDK's
   re-activate-on-check-miss rule the first time the updated client
   checks in. No delta re-imports.

Known, accepted gap: an existing install still on the old SDK cannot
activate a code sold post-flip (license-kit doesn't know it). New installs
get the latest version from the store, so this only affects an existing
user who buys during their extension's update lag — they activate once
the update arrives. If it ever bites in practice, license-kit can proxy
unknown codes through to extport (~20 lines); not built preemptively.

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
- **C — self-service.** `buyers` + `magic_links`, buyer portal (list
  licenses/devices, release a device as the manual escape hatch), tenant
  dashboard licensing UI.

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
