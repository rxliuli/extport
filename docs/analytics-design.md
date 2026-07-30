# Analytics (design)

Status: **design settled, not scheduled** (2026-07-30). This document is
the record of the scoping discussion — architecture, dimensions, the
four-store comparison, and the explicit non-goals. Implementation should
resume from here, and should not reopen the settled trade-offs without
new information.

## The product in one sentence

The Chrome Web Store developer console's Analytics section, but
cross-browser: installs, active users, and version distribution for
every store an extension ships to, unified in one dashboard.

That sentence is also the **scope rule**: what store consoles offer is
"official" and in scope; what none of them offer (error reporting,
funnels, session replay, user-level profiles) is out. It settles debates
before they start.

Why it fits extport:

- Same promise as publishing — aggregate four consoles into one surface.
- **Version saturation is the killer chart.** extport knows every
  version's release date (deployment_versions), so the stacked
  version-share curve gets release marker lines, and a sales-flip gate
  becomes "SDK share ≥ 95%" instead of a guessed two-week wait. The
  license-kit migration ran on exactly that guess.
- Licensing already holds the other half of a conversion funnel
  (purchases, amounts, per-extension). Installs → purchase conversion
  per store is a join, not a new event.
- Top of funnel: publishing needs release traffic and licensing needs
  paid products, but analytics is wanted by every extension developer,
  including free ones.

## Events and dimensions

Fixed event vocabulary: `installed`, `updated`, `opened`
(popup/options), and a daily activity ping. Custom events allowed but
capped (event name only, no properties) — Plausible's model, not GA4's.

Dimensions per event: **browser, extension version, country, language,
OS**. The client payload is only `install_id` + version + event +
language — the server derives country from `request.cf`, browser and OS
from the User-Agent. The client collects almost nothing, which is the
compliance story (see below). Region/language/OS is exactly the trio
every store console converged on; version is the extport-specific
addition.

**The SDK pings at most once per UTC day, client-side.** Event-driven
only (background wake), no `alarms`, no permissions — the same ruling as
the licensing heartbeat: a library must not demand host permissions, and
timers would fake liveness for abandoned installs. Client-side dedup
also means DAU = ping count, with no server-side distinct needed.

## Storage: three layers

| Layer | Store | Contents | Retention |
|---|---|---|---|
| Install state | D1 `installs` | one row per install: `install_id, extension, browser, first_seen, last_seen, last_version` | permanent (prunable after long idle) |
| Daily rollups | D1, nightly cron | single-dimension time series: headline (dau/mau/installs/churned) plus per-version, per-country, per-language, per-OS daily actives | **permanent** |
| Raw events | Workers Analytics Engine | every ping/event with all dimensions | **90 days, auto-deleted** (confirmed in CF docs; extension requires contacting CF) |

The boundary rule that makes the layering non-weird:

- **Single dimension × time → permanent rollup.** Store consoles
  themselves offer 5-year single-dimension views (CWS "Last 5 years"),
  so we cannot retain less. Cardinality is additive, not multiplicative
  — a per-country daily table is `date × extension × browser × country`,
  a few thousand rows/day at fleet scale, trivial for D1 forever.
- **Dimension crosses (country × version × …) and custom-event detail →
  the 90-day WAE window.** No store console offers cross-dimensional
  views at all; ad-hoc drill-down is honestly windowed.

Layer 1 exists so the exact metrics (MAU, current version distribution,
churn) never depend on WAE's SQL capabilities or sampling. WAE
adaptively samples at high volume (`_sample_interval` weighting) —
acceptable for slices, not for headlines.

Cross-day uniques (MAU/WAU) cannot be recomputed after raw data
expires: the cron snapshots "30-day MAU as of today" daily into the
rollup, and history is those snapshots.

## What the four consoles offer (surveyed 2026-07-30)

| | Metrics | Dimensions | Ranges | Export/API |
|---|---|---|---|---|
| CWS | installs/uninstalls, impressions, weekly users, **daily users by item version**, **enabled vs disabled**, ratings | region, language, OS, version | up to 5 years | CSV only |
| Edge Partner Center | weekly users, **enabled vs disabled**, daily installs, impressions | region, OS, language (no version) | month/3m/6m/all-time | CSV only |
| AMO | daily users, downloads (Firefox telemetry aggregate) | version, application, country, locale, OS; downloads by UTM | long | export; stats are the dashboard's |
| App Store Connect | downloads/impressions/page views (complete); sessions/active devices/retention (**opt-in only**) | territory/region, device, platform version, source type/referrer/campaign | flexible | **official Analytics API** |

Notes that shaped decisions:

- The CWS *console* has more than its docs describe (version breakdown,
  enabled/disabled) — trust screenshots over docs pages.
- ASC usage metrics measure the **container app**, which for a Safari
  extension is opened roughly once ever. For Safari, SDK telemetry is
  not "more unified" — it is the *only* usage signal in existence.
- Only browser-side telemetry can distinguish disabled from uninstalled
  (a disabled extension runs no code). CWS and Edge show it; we
  structurally cannot.

## Churn, not uninstalls

Nothing runs on uninstall. The metric is **inferred churn**: an
install's `last_seen` crossing the 30-day idle line, named "churn" on
the dashboard — never "uninstalls", which would claim store-console
parity we can't deliver (and their numbers measure store-side events
anyway).

Using `runtime.setUninstallURL` (with an `install_id` parameter) as the
SDK's uninstall-tracking mechanism was considered and **rejected**: it
pops a visible tab in the user's face at uninstall (a call the platform
must not make on tenants' behalf); the URL is a single per-extension
slot that belongs to the host extension, and a library occupying it is
the same namespace intrusion the licensing `alarms` ruling forbade;
Safari doesn't support it (breaking unified semantics); and per the
no-config principle it doesn't get a toggle. Tenants remain free to set
their own uninstall URL (e.g. a feedback survey) — the SDK never
touches that slot. Disabled-looks-like-churned is an accepted,
documented semantic gap.

## Cold-start import

Permanent-layer seeding so tenants (and tenant zero) see multi-year
curves on day one instead of an empty chart growing in real time:

- **CWS CSV — must** (largest user bases, 5-year history).
- **AMO export — worth it.**
- **Edge CSV — cheap, same pass.**
- **ASC — skipped.** Usage data is opt-in noise for container apps; the
  only comparable series is downloads; the Analytics API is a heavy
  async request/poll/snapshot flow; the fleet has one Safari product.
  Safari history honestly starts at SDK adoption.

Import writes only the permanent rollup layer, never WAE.

## Deliberately out of scope

- **Error/crash reporting.** Not a store-console feature; different
  data shape (stack blobs, grouping, source maps, issue lifecycle,
  alerting — Sentry's product, not three charts); and it contaminates
  the compliance story — "we only collect anonymous counters" dies with
  the first stack trace carrying a URL. Possibly a separate module
  (`@extport/sdk/errors`) someday; not glued into analytics.
- Impressions (only stores can see pre-install traffic — leave the
  panel blank or import later, don't fake it).
- Hour-level curves, user-level profiles, funnels, custom dashboards.
- Ratings aggregation is **in** scope (public per-store data, the
  reconcile cron already talks to all four stores) but low priority.

## Compliance is a feature

Privacy by construction: no PII, no cookies, pseudonymous per-install
random id, country from request geo rather than client collection. The
SDK ships with template disclosure text for the CWS data-use form and
Firefox's manifest data-collection declaration (this event set falls
under Mozilla's "technical and interaction data"). Making those two
forms easy to fill correctly is worth more to tenants than any metric.

## Rollout

- Dashboard charts via shadcn/ui charts (Recharts): DAU/MAU lines,
  installs-vs-churn bars, version-saturation stacked area with release
  markers.
- **No dedicated fleet release wave.** `@extport/sdk/analytics` is a
  separate subpath (zero cost to licensing-only users) and rides the
  next natural SDK wave — likely the license-kit-retirement release
  that drops the legacy cascade. The 11-product fleet is the first
  data source and dogfood; its saturation charts then replace guesswork
  for every future flip.
