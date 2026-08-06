# Fleet migration status (license-kit → extport)

Per-product progress tracker. The procedure is
[`migration-runbook.md`](migration-runbook.md); this file is where each
product actually stands. **Update this file as steps complete** — future
migration work resumes from here.

Last updated: 2026-08-06. **The license-kit → extport payment/licensing
migration is complete for every product** — every legacy code is
imported, every storefront buy button points at its extport Payment
Link. **license-kit's entire server backend has now been retired**
(routes/services/middleware/utils, D1 schema/migrations, KV, the
`main` Worker script all deleted; `@rxliuli/activation-client` deleted
and deprecated on npm) — see below; this closes out what used to be a
someday-task.

Separately — a different axis from this file's payment/licensing
tracking, noted here only because it overlaps the same product list:
the whole fleet was also bumped from `@extport/sdk` 0.0.2 to 0.0.8
(Substack Exporter already ahead, on 0.0.9 — the current npm latest)
and `@extport/wxt` to 0.0.6, with analytics (`analytics: true`) enabled
fleet-wide, as of 2026-08-05.

## Platform (done once — all live)

- `@extport/sdk` 0.0.7 dropped the dual-backend license-kit cascade and
  the `productName` config option entirely. The whole fleet has since
  moved past 0.0.7 (see the version table below) — the cascade is now
  historical, not something any currently-shipped build still exercises.
  The server still accepts `productName` as a cross-check fallback for
  any pre-0.0.7 client frozen in an old, never-updated install (see
  licensing.md) — that's a permanent server-side allowance, not a sign
  the fleet itself still depends on it.
- license-kit webhook skip patch deployed (`extport_plan` sessions ignored).
- Tenant webhook destination + live whsec stored; fulfillment, portal,
  refund→revoke all verified with real money.
- All release workflows on the extport actions recipe with 15-min job
  timeouts; `EXTPORT_API_KEY` set on every repo.

## Done — payment/licensing migration complete for every product

| Product | Version | SDK | Stores | Imported | Payment Link |
|---|---|---|---|---|---|
| **Substack Exporter** | 0.0.8 | 0.0.9 | chrome, firefox | — (sold entirely through extport since launch) | https://buy.stripe.com/aFa28raQae0V3fQ4LZ0ZW00 |
| Gemini Exporter | 0.0.5 | 0.0.8 | chrome | 1 | https://buy.stripe.com/8x24gz3nIaOJ03EguH0ZW01 |
| Reddit Exporter | 0.0.16 | 0.0.8 | chrome, firefox, edge | 28 | https://buy.stripe.com/8x23cvbUe7Cx6s21zN0ZW0f |
| Pinterest Exporter | 0.0.8 | 0.0.8 | chrome, firefox | 2 | https://buy.stripe.com/00w28rbUe7Cx6s2a6j0ZW09 |
| Pixiv Exporter | 0.0.7 | 0.0.8 | chrome, firefox | 2 | https://buy.stripe.com/3cI6oHaQa0a5dUua6j0ZW0a |
| Bluesky Exporter | 0.0.11 | 0.0.8 | chrome, firefox, edge | 2 (1 basic + 1 pro) | pro only: https://buy.stripe.com/7sY7sLe2maOJaIiban0ZW0b — basic plan exists solely for the import |
| Tumblr Exporter | 0.0.17 | 0.0.8 | chrome, firefox | 12 | https://buy.stripe.com/aFa5kD4rM5upaIidiv0ZW0c |
| Instagram Exporter | 0.0.21 | 0.0.8 | chrome, firefox, edge | 23 | basic tier: https://buy.stripe.com/eVq00jf6qf4Z17Icer0ZW0d |
| Claude Exporter | 0.0.13 | 0.0.8 | chrome, firefox | 4 | https://buy.stripe.com/28EcN5bUe6ytcQqcer0ZW0e |
| Twitter Blocker | 0.3.23 | 0.0.8 | chrome, firefox, edge, safari | 76 (+2 caught by the 2026-08-01 re-import) | $19.99: https://buy.stripe.com/3cI7sLcYi9KF4jUguH0ZW0g |
| Twitter Exporter | 0.8.58 | 0.0.8 | chrome, firefox, edge | 408 (+2 caught by the 2026-08-01 re-import; incl. one 4-device and one 6-device — maxActivations snapshots preserved) | basic $19.99, pro $39.99: https://buy.stripe.com/28E8wP8I26ytdUuban0ZW0h · https://buy.stripe.com/14A9ATe2m7CxaIia6j0ZW0i |
| Gmail Notifier | — | — | — | — | Out of scope — its only code was the author's own test; the licensing feature was later removed from the extension. |

**In-extension direct purchase (bypasses the storefront hop).** Every
product deep-links "Purchase" straight to its Stripe Payment Link
instead of opening store.rxliuli.com.

No further code-import runs are needed — every buy button is flipped,
so there's nothing new landing in Paddle to catch up on.

## license-kit backend — retired (2026-08-06)

Every storefront buy button had already been flipped and every legacy
code imported, so license-kit's checkout/webhook/activation endpoints
were seeing no live traffic before this — the actual deletion was a
formality, not a cutover. Done:

- All server-side code deleted: routes, services, middleware, utils,
  D1 schema/migrations/drizzle tooling, KV namespaces, the `main`
  Worker script itself. `wrangler.jsonc` now carries only `assets` +
  `routes` — Cloudflare's assets-only deployment mode, zero Worker
  script, zero request-time server logic.
- `@rxliuli/activation-client` (the pre-SDK client) deleted locally and
  deprecated on npm — confirmed via `npm view` on all three published
  versions.
- store.rxliuli.com's login now redirects straight to
  `portal.extport.dev` instead of a local auth page.
- The frontend was also rewritten from TanStack Start to Astro (a
  separate, unrelated axis — the site is fully static content either
  way, TanStack's SSR/hydration machinery was never needed). Zero
  client JS ships except the header nav and one page's copy-to-clipboard
  widget.

**Not yet done, low urgency:** if license-kit had its own registered
webhook endpoint(s) in Paddle's and/or Stripe's dashboards (separate
from extport's own, which are unaffected), those endpoints now point at
a dead route — worth explicitly deleting the registration in the
provider dashboard to stop failed-delivery noise, but nothing depends
on it and old clients fail open regardless (see below).

## productName → extensionId unfreezing — deliberately still deferred

Not a blocked/pending item — an active decision to leave
`extensions.name` frozen (`apps/api/src/routes/extensions.ts`'s freeze
check, unconditional while `licensingEnabled`) rather than unfreeze it.
No product has actually needed a rename since the SDK migration;
revisit only if one comes up for real.

## Retirement — done; post-retirement SDK release still deferred

Licensing.md § Fleet migration step 4: license-kit webhook + checkout
endpoints retire → post-retirement SDK release finishes dropping the
cascade support and switches the identity key `productName` →
`extensionId` fleet-wide, unfreezing extension names.

**The retirement half of step 4 is done** (2026-08-06, see above). The
**post-retirement SDK release is now unblocked but still deliberately
not scheduled** — same reasoning as the "productName → extensionId
unfreezing" section above: no product has actually needed a rename,
revisit only if one comes up for real. Until that release ships, a
mistyped code degrades from "invalid" to a retryable error (cosmetic,
typo path only) — **old clients fail open more broadly too**: the
pre-SDK hand-rolled clients treat any non-2xx from license-kit as a
thrown error that callers swallow, keeping the local cached
entitlement. So devices that never updated past the license-kit era
degrade to "checks fail forever, paid features never turn off" — the
documented failure mode, not a cliff.

### store.rxliuli.com endgame

| Component | Status |
|---|---|
| checkout endpoint | retired for every product (buttons are static Payment Link hrefs now) |
| Stripe/Paddle webhooks | endpoint code deleted (2026-08-06); any provider-side webhook registration still pointed at license-kit is dead but not yet explicitly removed (see above) |
| login + "my codes" pages | confirmed done — login redirects straight to portal.extport.dev |
| activation endpoints | deleted (2026-08-06) — old clients fail open, see above |
| product marketing pages | **kept forever** (SEO + buy links); now a fully static Astro site, zero server code, zero client JS beyond the header nav and one interactive widget |

## Known caveats carried forward

- All pre-flip codes for Paddle-era products carry `txn_…` sourceRefs:
  a Paddle refund reaches only license-kit, never extport's imported
  copy — revoke manually in the dashboard if it ever happens.
- Payment Links can't be deleted: seven deactivated first-attempt rows
  (inline price_data mistake) live permanently in the Stripe list;
  filter Status=Active.
- Product icons are URL references to store.rxliuli.com/icon/*.png — if
  that domain ever retires, re-upload images in the Stripe dashboard.
- None of the Payment Links have Stripe Tax enabled (`automatic_tax:
  false` on all 12, checked 2026-08-01) — Paddle was merchant-of-record
  and handled VAT/sales tax globally; Stripe here doesn't. At $9.6k+
  lifetime revenue spread across many countries the realistic exposure is
  low and this is a common posture at this scale, but it's a deliberate
  accepted risk, not a non-issue — revisit (flip on Stripe Tax, ~0.5%/txn)
  once revenue is meaningfully higher.
