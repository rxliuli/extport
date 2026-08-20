# Per-product migration runbook (license-kit → extport)

The strategy and its reasoning live in [`licensing.md` § Fleet
migration](licensing.md) — read that first. This file is the operational
checklist, distilled from the substack-exporter pilot (2026-07-28/29,
every step below verified live). Where each product currently stands:
[`migration-status.md`](migration-status.md). Tenant-zero specific by nature: paths
reference the license-kit repo and store.rxliuli.com.

## Platform prerequisites (done once — do not repeat)

- Dual-backend `@extport/sdk` published to npm (cascade: extport →
  license-kit on definitive rejection).
- **license-kit webhook skip patch deployed** (`b9146ef`): its Stripe
  webhook ignores checkout sessions carrying `extport_plan` metadata.
  This must be live before any product's first extport sale — without it
  a sale double-fulfills (two codes, two emails), *and* license-kit
  throws on the missing `product_name`/`tier` metadata → 500 → Stripe
  retry storm.
- Live webhook destination — **per tenant, covers every product**:
  `https://api.extport.dev/api/v1/licensing/webhooks/stripe/<tenantId>`
  listening to `checkout.session.completed`, `charge.refunded`,
  `charge.dispute.created`; its live `whsec_…` stored in dashboard
  Settings → Payment credentials (single slot — live replaced test on
  2026-07-29; don't expect test-mode flows to verify after that).

## Per product

### 1. Client swap

> **Historical:** every product completed this step by 2026-08-05; the
> pre-0.0.7 `productName` identity it describes is retired (see
> [`migration-status.md`](migration-status.md)).

- Extension exists in extport with licensing enabled; plan rows created
  in the dashboard Licensing tab (tier + max devices).
- (Pre-0.0.7 only) the `productName` passed to the SDK had to equal the
  extension's `name` in extport **exactly** — the name was frozen while
  licensing was enabled; the `extensionId` switch at retirement ended
  both the requirement and the freeze.
- Swap `@rxliuli/activation-client` → `@extport/sdk` (substack-exporter:
  4 imports + delete the `apiBase` line); `attachBackground` in the
  background entrypoint; `extport.config.json` carries the `ext_…` id.

### 2. Release, then wait for the right gate

Push through extport as usual. **The gate for flipping sales: every
store the product sells on has an SDK-carrying version as its live
version** (dashboard Versions matrix). New buyers always install the
store's latest, so *installed-base* saturation gates nothing here — it
only gates retirement. Corollaries, both verified:

- A store whose *first* submission is still in review (Edge for
  substack-exporter) has zero installed base → not a gate. Add its
  target and CI config after it goes live.
- Old installs keep resolving their old codes through the license-kit
  cascade regardless of when you flip.

### 3. Stripe: one live Payment Link per plan

Reuse the existing live Price (the one license-kit already sells with).
Paddle-era products have no Stripe Price — create a catalog Product first
(`POST /v1/products` with `default_price_data`), then reference that price
from the link. **Never use the payment link's inline `price_data`**: it
creates an invisible one-off product that never appears in the Product
catalog and can't be reused for another link. And there is no undo:
payment links can only be deactivated, never deleted — every mistake is
a permanent row in the dashboard list (filter Status=Active to hide
them), so get the shape right before creating. Via the API (unlike the
dashboard form) metadata and the redirect can be set at creation time,
skipping the detail-page step below:

1. *Edit metadata*: `extport_plan` = the `plan_…` id from the dashboard
   plans table. Without it the sale fulfills nowhere.
2. *After payment* → redirect to
   `https://portal.extport.dev/purchase/success?session_id={CHECKOUT_SESSION_ID}`
   (placeholder stays literal).
3. *Allow promotion codes* — also what makes the $0 verification below
   possible.

Single-tier products deep-link this URL from the upgrade button;
multi-tier uses static per-tier links in the plan dialog.

### 4. Flip the buy buttons

- Storefront product page: pricing action `{ type: 'stripe', priceId }`
  → `{ type: 'link', href: <payment link URL> }`.
- Extension side: only if the upgrade button deep-links checkout
  directly (substack-exporter's points at the storefront page — no
  extension release needed).
- Deploy: `pnpm build && pnpm deploy:server` from
  `license-kit/packages/store` — **build first**; wrangler uploads
  `dist` as the site assets, deploying stale/empty output nukes
  the live storefront. (Historical note: this repo's backend has since
  retired and the frontend migrated to Astro — see
  [`migration-status.md`](migration-status.md) — but the two-step
  build-then-deploy shape is unchanged.)

### 5. Verify with a $0 live purchase

Cost-free end-to-end proof (the only way to prove the whsec matches —
live mode can't send synthetic events):

1. Stripe → Coupons → create: 100% off, duration *Once*, **limit total
   redemptions to 1**, customer-facing code enabled.
2. Check out through the Payment Link with the code (email only, no
   payment method collected). Expect all of:
   - portal success page shows the activation code;
   - fulfillment email arrives;
   - `licenses` row: `source = stripe_webhook`, `sourceRef = cs_live_…`
     — zero-dollar sessions have no PaymentIntent, the session-id
     fallback is by design;
   - Stripe destination shows the delivery with 0 failed;
   - license-kit DB gained **no** new `activation_code` (skip patch
     proof).
3. Optional full-money pass: real purchase, then refund it. Refund
   reason **Requested by customer — never Fraudulent** (that
   Radar-blocklists the payment method, i.e. your own). The license
   flips to `refunded` on `charge.refunded`; license-kit receives the
   same event and answers `no_payment_found` — harmless.

Notes that came out of the pilot:

- Alipay: refunds full/partial within 90 days of payment, async (≤5
  min), and **no dispute mechanism** — `charge.dispute.created` never
  fires for it.
- Email division of labor: Stripe owns money receipts (enable *Refunds*
  under Settings → Customer emails, or per-payment *Send receipt* —
  default is off); extport sends exactly one email, the fulfillment
  code. Revocation is deliberately silent — the refund the buyer
  themselves requested is the notification.

### 6. Import (any time after the flip)

```sh
node scripts/import-license-kit.mjs --product "Product Name"          # dry run
node scripts/import-license-kit.mjs --product "Product Name" --apply
```

Idempotent — re-run near retirement to pick up stragglers. Acceptance
(hard): a device activated under license-kit passes `check` against
extport with zero re-activation. The import gates only license-kit's
retirement, never the flip.

### Rollback

Swap the storefront button back to the old checkout action and deploy.
Nothing else moved: verification, old codes, and refund handling for
pre-flip sales never left license-kit.

## Retirement (after the last product)

See [`licensing.md`](licensing.md) § Fleet migration step 4: license-kit
webhook and checkout endpoints retire, and the same post-retirement SDK
release drops the cascade entry and switches the identity key from
`productName` to `extensionId` (unfreezing extension names).
**Done 2026-08-20** — the identity switch shipped with SDK 0.0.7 and
the server-side tail (wire-compat fallback + name freeze) is now
retired; see [`migration-status.md`](migration-status.md).
