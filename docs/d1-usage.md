# D1 usage

Where extport's D1 reads and writes come from, what was done about them, and
the checks still open. The dashboard has a single tenant, but D1 traffic is
driven by the fleet's end users (every active install pings daily) and by
the half-hourly reconcile sweep — not by dashboard use.

How to look: `npx wrangler d1 insights extport --timePeriod 1d --sort-by count`
from `apps/api` (also `--sort-by reads` / `writes`, `--json`), or the
[D1 metrics page](https://dash.cloudflare.com/f9592092c1e8cfe4a09f5c4cf8188ecc/workers/d1/databases/86961734-96e0-4e8e-ba2d-48423b94ff46/metrics)
with "Last 24 hours" selected. Prefer a 24-hour window when checking a
change: the 30-day view stays dominated by pre-change traffic for weeks.

## Baseline (30 days to 2026-11-17)

~3M queries, ~10M rows read, ~2M rows written, 166 MB stored.

| Source | Queries / 30d | Rows written / 30d |
|---|---|---|
| Analytics ping (`POST /v1/analytics/ping`): extension lookup + idempotency read + install upsert, ~32k pings/day | ~2.7M | ~940k |
| Nightly rollup DAU/WAU upserts into `analytics_daily` (4 rows written each: table + 2 indexes) | ~260k | ~675k |
| Reconcile sweep target lock (`reconciling_since` claim + release) | ~233k | ~233k |
| Reconcile sweep `deployment_versions` read (whole history, every tick) | ~1.7k | — (1.4M rows read) |

The one-off rows-read spike around 2026-10-22 (~2.4M rows in 6 runs) was
ad-hoc console queries with literal `browser`/`dim`/`date` filters, which no
index serves — a full scan of `analytics_daily` (~333k rows) each.

## Changes and follow-ups

- `3d7ef2e` (2026-11-17): the ping endpoint does its D1 work in one
  `INSERT … SELECT … ON CONFLICT … RETURNING` instead of three statements.
  Verified in [#1](https://github.com/rxliuli/extport/issues/1) (2026-11-19):
  ping dropped from ~106k → 35.4k queries/day.
- `4090a25` (2026-11-17): the sweep checks for settled targets before taking
  the target lock, so idle targets cost no writes. Verified in
  [#1](https://github.com/rxliuli/extport/issues/1) (2026-11-19): lock
  claims dropped from ~4.2k → 824/day (~1:1 with `last_reconciled_at`).
- `3ca08c0` (2026-11-19): slowed dashboard polling from 30s to 5m and added
  composite tenant indexes on `deployment_versions` (`(tenant_id, status)`
  and `(tenant_id, version)`). Verified in
  [#3](https://github.com/rxliuli/extport/issues/3) (2026-11-21): 24h
  `d1 insights` rows read dropped from 2,899,565 → 479,244 (-83.5%;
  `d1 info` `rows_read_24h` 1,048,757), `/api/v1/extensions/matrix` queries
  dropped >92%, and `tenant_id + version in (…)` dropped from ~940 to
  171–197 rows read/run.
- The sweep reading all of `deployment_versions` every tick (the slowest
  regular query, growing with every release):
  [#2](https://github.com/rxliuli/extport/issues/2).
- Rollup writes into `analytics_daily` (~a third of all rows written) are
  the cost of the per-dimension breakdowns. Reducing them is a product call —
  fewer dimensions, or dropping an index nothing reads — not a bug.
