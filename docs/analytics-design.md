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

## The wire protocol: one ping

There is exactly one client event — the daily ping:
`install_id + extension + version + language`. The server derives
country (`request.cf`) and browser/OS (User-Agent), and everything else
is inference over pings:

- **install** — an `install_id` seen for the first time
- **update** — a ping whose version differs from the install's last one
- **active** — the ping itself
- **departure** — 30 days of silence, attributed to the last-seen day

No event field exists on the wire, so there is nothing to extend,
validate, or cap — custom events aren't forbidden, they're unwritable
(see non-goals). Browser/version/country/language/OS is exactly the
dimension set the store consoles converged on, and the client payload
carries almost none of it, which is the compliance story (below).

**The SDK pings at most once per UTC day, client-side.** Event-driven
only (background wake, plus immediately on `onInstalled` so install
timing is accurate), no `alarms`, no permissions — the same ruling as
the licensing heartbeat: a library must not demand host permissions,
and timers would fake liveness for abandoned installs. The server
enforces the same idempotency independently — a ping only counts if
the install's `last_seen` predates today — so a misbehaving client
cannot inflate anything.

## Storage: three D1 tables, no second system

| Table | Contents | Retention |
|---|---|---|
| `pings_raw` | one row per accepted ping, all dimensions resolved | **90 days, pruned by our own cron** |
| `installs` | one row per install: `first_seen, last_seen, last_version` | permanent (prunable after long idle) |
| `analytics_daily` | single-dimension time series: headline (dau/wau/mau/installs/departures) plus per-version, per-country, per-language, per-OS daily+weekly actives | **permanent** |

Ingest is insert-only: one `pings_raw` insert plus one `installs`
upsert. A nightly cron aggregates yesterday's raw rows into
`analytics_daily` (one GROUP BY per dimension), computes rolling 7-day
WAU and 30-day MAU — both `count(DISTINCT install_id)` over raw pings,
exact, since both windows sit inside the 90-day raw window; the nightly
write is what makes them permanent, because cross-day uniques can't be
recomputed after raw data ages out — counts newly confirmed departures
(written into the row of the day the install was last seen, 30 days
back; see below), and prunes raw rows past 90 days. An earlier
iteration snapshotted MAU from `installs.last_seen`; the pointer's
forward drift between midnight and the cron silently dropped same-day
actives (day-one extensions showed MAU < DAU), which is why everything
now derives from raw pings.

**WAU is the headline activity metric** — every displayed figure and
the Active users chart read it; dau stays in the rollup (and drives
version saturation), mau accrues unread as the permanent 30-day record.
Two reasons beyond smoothing: it's what the CWS console headlines
(weekly users), and the event-driven ping undercounts single days by
design — a running-but-idle browser can miss a day, rarely a week.

The boundary rule: **single dimension × time → permanent.** Store
consoles themselves offer 5-year single-dimension views (CWS "Last 5
years"), so we cannot retain less. Cardinality is additive, not
multiplicative — a per-country daily table is `date × extension ×
browser × country`, a few thousand rows/day at fleet scale, trivial
for D1 forever. The raw window exists for *recomputation*, not for
product features — every promised chart reads `analytics_daily` or
`installs`.

Two designs were rejected here:

- **Aggregate-on-write counters** (the ping handler increments daily
  rows directly, no raw table): every bucketing bug becomes permanent
  — a week of misparsed User-Agents would be unrecoverable. Insert-only
  ingest costs the same and any rollup bug within the window is fixed
  by recompute.
- **Workers Analytics Engine as the raw layer**: its 90-day cap means
  every promised read hits D1 anyway, so it was never load-bearing;
  its one real job — ad-hoc cross-dimension slicing — fell out of
  scope under the console razor (no store console offers crosses); and
  it samples at volume. This design knowingly rebuilds WAE's shape
  inside D1, gaining full SQL, exact counts, a retention policy we own
  rather than inherit, and one fewer storage system.

Scale ceiling, honestly: D1 is a single writer and the raw table grows
with DAU — 50k DAU ≈ 4.5M rows at 90 days (comfortable); a 1M-DAU
tenant would not be. The escape hatch when a whale arrives: move the
raw buffer to a queue (or WAE), keep everything else — the read model
never changes.

### Cost model and the bundled-not-metered decision (2026-08-02)

Revisited when the fleet's first full-volume day (~16k pings) made
analytics dominate the D1 query metrics and raised the SaaS question:
should analytics be a gated/paid toggle, or can plans simply absorb it?
The unit economics, worked out against Workers Paid quotas:

- One daily-active install costs ~7.5 rows written/day (1 ping insert
  ≈ 3 rows with indexes, 1 installs upsert ≈ 4.5 — index writes count
  as rows written) ≈ **225 rows written per DAU-month**.
- The plan includes 50M rows written/month → the write meter is the
  binding one and covers **~220k fleet-wide DAU before the first
  overage dollar**. Overage is linear ($1/M rows): ~**$0.23 per 1,000
  DAU per month**, so a 100k-DAU tenant costs ~$23/month — and that
  tenant is exactly whose licensing revenue is worth the most. Reads
  are three orders of magnitude from mattering (25B/month included vs
  ~2M/day used, rollup scans included).

Decision: **analytics ships bundled in plans, never metered or gated
server-side.** It is already opt-in at the integration level
(`extport: { analytics: true }` per extension; no flag → zero pings →
zero cost), and a paid toggle would spend pricing complexity and a new
config surface to save cents. WAE migration was re-examined and
re-rejected on the same grounds as above, now stronger: the exactness
guarantees added since (WAU/MAU/version shares all
`count(DISTINCT install_id)` over raw) are incompatible with WAE's
sampling, and `installs` (point lookups + mutations, the *larger* write
item) can't move to an append-only store anyway.

Re-evaluation trigger: **monthly rows written crossing 50% of the
included quota** (~110k fleet DAU). First lever at that point is index
audit on `analytics_installs` (indexes are most of its 4.5× write
multiplier), then the raw-buffer escape hatch — paired, if it's a
single whale tenant, with a DAU-tiered pricing plan introduced at the
same moment. Engineering and pricing move together; neither moves now.

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

## Departures, not uninstalls

Nothing runs on uninstall. The metric is the **inferred departure**: an
install that stays silent for 30 days — named "departures" on the
dashboard, never "uninstalls", which would claim store-console parity
we can't deliver (and their numbers measure store-side events anyway).

**Attribution goes to the last-seen day, not the day the idle line is
crossed.** Dating departures by crossing day would be doubly wrong: the
whole curve shifts a month late, and a spike would point post-mortems
at the wrong week (a botched July 15 release would read as an August
exodus). Dated by last-seen day, the semantics are exact — that *is*
the day they left — at an honest cost: **a day's count is only
confirmed 30 days later** (until then returners keep shrinking it), so
the chart draws confirmed days only and leaves the trailing 30 days
blank, labeled "confirmed after 30 days of silence". Same principle as
impressions: blank over fake.

This makes the chart a **post-mortem tool, not a monitoring one** — and
that's fine, because real-time exodus detection was never its job: a
mass departure shows up in the DAU curve the next day, and installs
(`first_seen`) are same-day exact. Those two lines monitor; departures
quantify a month later.

Edge cases that resolve themselves: the cron computes departures
anyway (confirmation is just writing the count into the D−30 rollup
row, cost zero), and an install that returns after 40 days genuinely
did depart and come back — the historical departure stands, and the
return is not a new install (same `install_id`), so nothing needs
retroactive correction.

Using `runtime.setUninstallURL` (with an `install_id` parameter) as the
SDK's uninstall-tracking mechanism was considered and **rejected**: it
pops a visible tab in the user's face at uninstall (a call the platform
must not make on tenants' behalf); the URL is a single per-extension
slot that belongs to the host extension, and a library occupying it is
the same namespace intrusion the licensing `alarms` ruling forbade;
Safari doesn't support it (breaking unified semantics); and per the
no-config principle it doesn't get a toggle. Tenants remain free to set
their own uninstall URL (e.g. a feedback survey) — the SDK never
touches that slot. Disabled-looks-like-departed is an accepted,
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

Import writes only the permanent rollup layer, never the raw table.

## Deliberately out of scope

- **Custom events.** Cut entirely — no store console has them, and
  they are the top of the GA4 slope (events want properties,
  properties want funnels). Cutting them is also what collapsed the
  wire protocol to a single ping. If fine-grained "which feature gets
  used" instrumentation ever materializes as real tenant demand, it
  belongs to a future instrumentation/logging module alongside error
  reporting — not this dashboard.
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

Learned on the imp-translate canary (2026-07-30):

- CWS form: country-from-IP means checking **Location** (its examples
  name "region, IP address"), and the checked category shows publicly
  on the listing's Privacy practices tab.
- AMO **rejects `technicalAndInteraction` in
  `data_collection_permissions.required`** — Firefox's position is that
  technical data must always be user-declinable, so it can only be
  declared `optional` (an install-time toggle, manageable later in
  about:addons). The extension must then honor the toggle at runtime:
  `permissions.getAll().data_collection` (key absent = browser without
  the mechanism → manifest-level disclosure governs), re-synced on
  `permissions.onAdded`/`onRemoved`. **Done in SDK 0.0.4**: the ping
  gate reads `permissions.getAll().data_collection` fresh on every
  attempt (revocation needs no listener) and `onAdded` triggers a
  same-day ping on grant — `attachAnalytics({ extensionId })` is the
  entire integration.
- Next step, discussed but not built: `@extport/wxt` can collapse even
  that to `extport: { analytics: true }` — a WXT plugin injecting
  `attachAnalytics` with the id from extport.config.json (killing the
  id duplication) plus a manifest hook merging the Firefox
  data-collection declaration. Explicit opt-in only (a publishing
  module must never inject telemetry silently), and it lands *after*
  Redirector ships on the plain one-liner — the flagship test uses
  boring machinery.
- The Firefox install prompt shows the technicalAndInteraction toggle
  **checked by default** (verified on a real install) — opt-out, not
  the host_permissions default-deny pattern. Still unverified: whether
  an *update* that adds the optional declaration grants it for existing
  installs; the canary's Firefox DAU answers this empirically.
- **CI e2e runs are an analytics pollution vector**: every Playwright
  context loading the production build is a fresh "install" pinging
  production (~20 phantom US/Linux installs per workflow run). Ingest
  drops `HeadlessChrome` UAs; the fleet convention is e2e launches with
  `--headless=new` (also the only mode that loads MV3 extensions).
  Headed-under-xvfb CI would evade the filter.
- Client aborts can cancel the Worker mid-handler — multi-write ingest
  paths must be one `db.batch()` or phantom half-written state appears
  at CI-burst rates.

## Store disclosure templates (answers + why)

The raw material for the future tenant guide. The *reasons* are the
part that decays — they were worked out on the imp-translate canary
and belong here verbatim.

### CWS "What user data do you plan to collect" form

Check **Location** only. Its examples literally name "region, IP
address" — we derive and store country from the request IP (IP itself
not stored). Note the checked category shows publicly on the
listing's Privacy practices tab.

Every other box unchecked, with the reason on record:

- *PII* — examples are name/address/email/age/ID number; a random
  install UUID is linked to nothing.
- *User activity* — examples are "network monitoring, clicks, mouse
  position, scroll, keystroke logging": behavioral **content**
  monitoring. The ping carries zero behavioral content; "the
  extension was alive today" is one bit.
- *Web history / Website content* — never touched.
- *Health / Financial / Authentication / Personal communications* —
  obviously none.
- Language (`navigator.language`) and extension version fall under no
  listed category.

Checking anything makes the listing's **privacy policy URL** field
mandatory. The residual ambiguity is the daily UUID (a strict reviewer
could stretch "identification number") — accepted after imp-translate
cleared review with exactly this configuration.

### App Store Connect App Privacy (Safari-shipping extensions)

- Data type: **Identifiers → Device ID** (the anonymous install id
  lands in this bucket in Apple's taxonomy).
- Purpose: **Analytics**.
- "Linked to the user's identity": **No** (no account linkage,
  generated locally).
- "Used for tracking": **No** — Apple's "tracking" is a term of art:
  linking user/device data with *third-party* data for targeted
  advertising or ad measurement, or selling to data brokers.
  First-party anonymous statistics are categorically outside it.
  (Answering Yes would drag iOS into AppTrackingTransparency prompt
  territory — a world we never need to enter.)

### AMO / Firefox

The manifest declaration (`data_collection_permissions.optional:
['technicalAndInteraction']`) *is* the disclosure — see the canary
lessons above for why it cannot be `required`. The listing needs only
the privacy policy link.

### Privacy policy paragraph

imp-translate's PRIVACY.md "Anonymous Usage Statistics" section is the
canonical template: exact field list, "IP used only for country lookup
and not stored", 90-day raw retention, no browsing data. Fleet and
tenants copy it verbatim.

## Integration: @wxt-dev/analytics provider

WXT ships a first-party analytics module — a thin message bus
(frontend contexts forward calls to the background over a runtime
port) with pluggable providers that implement three upload functions
(`page`/`track`/`identify`). Lifecycle tracking is provider-side, and
the reference provider (Moderok) independently converged on this
document's exact ping design: init-time UTC date-stamp dedup in
storage, an `onInstalled` listener, no alarms.

extport ships a provider as a subpath export
(`@extport/sdk/wxt-analytics`) — **an adapter, not the foundation**:

- The primary ping implementation lives in `@extport/sdk` itself (the
  `attachBackground` hook the fleet already calls), framework-free.
  The provider is a thin shell over that same client.
- The provider forwards lifecycle pings only. `track`/`page`/
  `identify` are no-ops (debug-mode warning: extport has no custom
  events — run PostHog/Umami alongside in the same `providers` array
  for that; the module fans events out to every provider). `autoTrack`
  payloads are never forwarded: click `textContent` can carry user
  content.
- **Double integration dedupes structurally**, not just at the server:
  both paths call the same client, guarded by a module-level in-flight
  promise (same-startup race), a shared `extport:last-ping-date`
  storage stamp (across service-worker restarts), and the server's
  `last_seen` gate as the final backstop. The consent flag is likewise
  one shared storage item, so the two integrations cannot disagree
  about whether analytics is on.
- The wxt module's `enabled` flag defaults to **false** — consent
  plumbing for free (pairs with Firefox's data-collection
  declarations). Tenants wanting always-on anonymous counters opt in
  explicitly; that decision belongs to the tenant, never the library.
- Distribution: Moderok entered the module's built-in provider list by
  upstream PR; `providers/extport.ts` should take the same path once
  the service is real.

## Rollout

- Dashboard charts via shadcn/ui charts (Recharts): **per-store
  rolling-7-day WAU lines** (one line per browser, fixed colors — the
  view no single store console can draw, and where divergence stories
  surface; the stat cards read the same WAU, so a card can never
  disagree with the chart beside it), "Weekly users by
  country/language/OS" breakdown cards (top 5 + Other, labels via
  Intl.DisplayNames — raw codes stay in the rollup), installs and
  confirmed-departures bars (the latter trailing 30 days),
  version-saturation stacked area with release markers. Default window
  30 days (CWS parity); a range picker (30/90/1y/all) joins once
  enough history exists to navigate.
- **No dedicated fleet release wave.** `@extport/sdk/analytics` is a
  separate subpath (zero cost to licensing-only users) and rides the
  next natural SDK wave — likely the license-kit-retirement release
  that drops the legacy cascade. The 11-product fleet is the first
  data source and dogfood; its saturation charts then replace guesswork
  for every future flip.
