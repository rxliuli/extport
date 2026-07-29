# Fleet migration status (license-kit → extport)

Per-product progress tracker. The procedure is
[`migration-runbook.md`](migration-runbook.md); this file is where each
product actually stands. **Update this file as steps complete** — future
migration work resumes from here.

Last updated: 2026-07-29.

## Platform (done once — all live)

- Dual-backend `@extport/sdk` 0.0.2 on npm; cascade verified both ways
  (migrated codes resolve on extport, un-migrated fall back to license-kit).
- license-kit webhook skip patch deployed (`extport_plan` sessions ignored).
- Tenant webhook destination + live whsec stored; fulfillment, portal,
  refund→revoke all verified with real money.
- All release workflows on the extport actions recipe with 15-min job
  timeouts; `EXTPORT_API_KEY` set on every repo.

## Done

| Product | State |
|---|---|
| **Substack Exporter** | Fully migrated: sales flipped, codes imported, $0 + real-purchase + refund verified. license-kit serves only its legacy-code verification via the cascade. |
| **Gmail Notifier** | Out of scope — its only code was the author's own test; the licensing feature was later removed from the extension. Nothing to migrate. |

## In flight — SDK shipped, waiting on store review + ~2-week auto-update saturation (until ~2026-08-12)

All of these already have: extension + plans in extport, store targets,
codes imported (except where noted), and a live Payment Link (inert until
the storefront flip).

| Product | SDK version | Stores | Imported | Payment Link |
|---|---|---|---|---|
| Gemini Exporter | 0.0.2 (queued behind 0.0.1 first review) | chrome | 1 | **already flipped** — zero installed base, sales live on extport now: https://buy.stripe.com/8x24gz3nIaOJ03EguH0ZW01 |
| Reddit Exporter | 0.0.13 (chrome+firefox in review, edge queued) | chrome, firefox, edge | 28 (31 activations) | https://buy.stripe.com/8x23cvbUe7Cx6s21zN0ZW0f |
| Pinterest Exporter | 0.0.5 (firefox in review; **chrome blocked on CWS listing compliance — cookies justification submitted, extport auto-retries every 30 min**) | chrome, firefox | pending | https://buy.stripe.com/00w28rbUe7Cx6s2a6j0ZW09 |
| Pixiv Exporter | 0.0.5 (both in review) | chrome, firefox | pending | https://buy.stripe.com/3cI6oHaQa0a5dUua6j0ZW0a |
| Bluesky Exporter | 0.0.9 (all three in review) | chrome, firefox, edge | pending (1 basic + 1 pro) | pro only: https://buy.stripe.com/7sY7sLe2maOJaIiban0ZW0b — basic plan exists solely for the import |
| Tumblr Exporter | 0.0.15 (both in review) | chrome, firefox | pending | https://buy.stripe.com/aFa5kD4rM5upaIidiv0ZW0c |
| Instagram Exporter | 0.0.19 (all three in review) | chrome, firefox, edge | pending | basic tier: https://buy.stripe.com/eVq00jf6qf4Z17Icer0ZW0d |
| Claude Exporter | 0.0.11 (both in review) | chrome, firefox | pending | https://buy.stripe.com/28EcN5bUe6ytcQqcer0ZW0e |

**At the end of the wait, per product:** flip the storefront buy button
to the Payment Link → run the import (`scripts/import-license-kit.mjs
--product "…" --apply`) → one $0 promo-code purchase as end-to-end
verification (runbook §5). Reddit's import already ran; re-run near
retirement for stragglers.

## Held back deliberately — largest paying user bases

Client swap intentionally deferred until the batch above is flipped and
verified (author's call: prove the recipe on low-volume products first).
Stripe side is fully prepared; the swap itself is a mechanical
`@rxliuli/activation-client` → `@extport/sdk` replacement and a CI
release.

| Product | Codes (active) | Plans | Payment Links |
|---|---|---|---|
| Twitter Blocker | 71 (67) | pro/3 | $19.99: https://buy.stripe.com/3cI7sLcYi9KF4jUguH0ZW0g |
| Twitter Exporter | 402 (386), incl. one 4-device and one 6-device code (per-license maxActivations snapshots survive import) | basic/3 + pro/3 | basic $19.99: https://buy.stripe.com/28E8wP8I26ytdUuban0ZW0h · pro $39.99: https://buy.stripe.com/14A9ATe2m7CxaIia6j0ZW0i |

## After the last product flips

Retirement sequence (licensing.md § Fleet migration step 4): final
straggler imports → license-kit webhook + checkout endpoints retire →
post-retirement SDK release drops the cascade and switches the identity
key `productName` → `extensionId`, unfreezing extension names.

## Known caveats carried forward

- All pre-flip codes for Paddle-era products carry `txn_…` sourceRefs:
  a Paddle refund reaches only license-kit, never extport's imported
  copy — revoke manually in the dashboard if it ever happens.
- Payment Links can't be deleted: seven deactivated first-attempt rows
  (inline price_data mistake) live permanently in the Stripe list;
  filter Status=Active.
- Product icons are URL references to store.rxliuli.com/icon/*.png — if
  that domain ever retires, re-upload images in the Stripe dashboard.
