# Incident ledger

Every production incident, its root cause, and the invariant it taught.
This file exists because each of these bugs looked like a one-off until
the pattern behind it repeated somewhere else — read the invariants
before touching the reconcile loop, a store adapter, or anything that
runs inside a Workers request. Newest first within each theme.

## The invariants

1. **Platform lifetime limits are architecture, not trivia.**
   `ctx.waitUntil` work dies ~30 seconds after the HTTP response; cron
   gets 15 minutes; a queue consumer gets 15 minutes; a synchronous
   handler lives while the client stays connected. Any work that can
   outlive its container's budget on a store's bad day (retry backoff,
   slow validation polls) must run in a container with headroom — that
   is why push-triggered reconciles go through the `extport-reconcile`
   queue and never `waitUntil`.
2. **A killed invocation writes nothing — deaths must leave a trace by
   construction.** No catch block runs, no event, no email. The only
   artifact is whatever state it already claimed (the target lock), so
   the lock reclaimer files the `interrupted` event on the dead
   invocation's behalf. Never assume "no error recorded" means "nothing
   went wrong".
3. **A lock's staleness window must exceed the slowest legitimate
   operation it protects.** 2 minutes was shorter than one Edge submit;
   the reclaim re-ran a live submit and Microsoft got two submissions.
4. **Store "busy" signals are waiting semantics, not errors.** Edge's
   `InProgressSubmission`, Safari's build-not-yet-processed, Edge
   validation outlasting the poll window — all mean "try next tick".
   Mapping them to errors produces alarm emails about normal operation.
5. **The severity of a failure depends on what the call was for, not
   what the error says.** A 500 during an idle status poll is noise; the
   same 500 blocking a queued submit is an alert. The routine sweep
   therefore skips settled targets entirely — no idle calls, no idle
   errors, and the store-side rate-limit budget stays available for real
   submissions.
6. **Submit flows must be resumable from every partial state, and the
   resume checks must be proven against real API responses.** Each step
   reuses/skips what a dead predecessor left behind. Two traps found so
   far: ASC omits `relationships.*.data` unless the request passes
   `include=`, which silently blinded an already-added check; and a
   store's own "already done" rejection (ASC "was already added", HTTP
   409) is the step's success condition, not a failure.
7. **Store state enums mean what the store says, not what the name
   suggests.** ASC's version-level `READY_FOR_REVIEW` means "prepared,
   review NOT yet requested" — bucketing it as in-review deadlocked a
   release, exactly like `PREPARE_FOR_SUBMISSION` would have. When an
   enum value shows up that the adapter hasn't verified against reality,
   default it to "not in review" so the submit path stays in charge.
8. **Some store facts are permanently unobservable — design for the
   gap, don't poll for it.** Edge has no API to see the in-review
   version (request declined by Microsoft, MicrosoftEdge-Extensions#696);
   ASC can't upload binaries. Ledger writes that race real store-side
   work (push superseding a queued row whose submit already landed) must
   tolerate the store knowing more than the ledger.
9. **Observation channels record everything a browser could have sent
   and drop only the mechanically impossible.** Analytics pings are
   filtered on transport facts (no UA, HeadlessChrome, UA with no
   browser token) — never on content being "unexpected" (an unknown
   version string is a signal, not junk). Publicly writable endpoints
   will be probed; make probes inert, not invisible.
10. **An Edge review stuck past the 10-day reminder has exactly two
    causes, and only Partner Center's own UI can tell them apart.**
    "In draft" = the submit request was accepted but the version never
    entered review (listing-completeness gap, e.g. missing permission
    justifications): fix the listing, mark the row skipped, let the
    queued successor submit. "In review" = Microsoft is genuinely slow:
    wait or open a support ticket, and never cancel-and-resubmit — that
    re-enters the queue at the back. extport cannot automate the triage
    (invariant 8); the daily stale reminder's whole job is to prompt
    this one human check.

## Incident log

### 2026-08-13 — Twitter Filter safari v0.0.66: one death, three layers

A push-triggered reconcile hit an ASC 500 storm; retry backoff pushed it
past `waitUntil`'s ~30-second post-response budget and the runtime
killed it mid-submit (invariants 1, 2). The half-finished submit left
macOS at version-level `READY_FOR_REVIEW`, which getState bucketed as
in-review, so the resolve step marked the queued row in_review and the
submit resume never ran — a deadlock only a manual row flip could exit
(invariant 7). After the flip, the resume tripped over its own leftover
submission item because the items listing lacked `include=appStoreVersion`
and the already-added check compared against `undefined` (invariant 6).
Meanwhile the death itself was invisible: no event, no email, 19 minutes
of "everything is fine" (invariant 2).

Fixes: `647bd6d` (push reconciles via queue), `b3aea73`
(`READY_FOR_REVIEW` is pre-submission), `9de799f` (include param +
tolerate "already added" 409), `1d983a5` (`interrupted` event on stale
lock reclaim).

### 2026-08-13 — two Edge reviews past 10 days: one draft-stall, one genuinely slow

The stale-review sweep surfaced both shapes of invariant 10 on the same
day. Instagram Exporter v0.0.19: submitted 07-29, Edge accepted the
request but the version sat "In draft" for 11 days because the release
added two permissions (`notifications`,
`declarativeNetRequestWithHostAccess`) whose Privacy-page
justifications weren't filled — v0.0.21 was blocked behind the phantom
the whole time. Resolution: fill the justifications in Partner Center,
flip the row to skipped, reconcile — v0.0.21 uploaded over the draft
and entered review in 30 seconds. Scrub v0.0.17: submitted 07-30, all
listing checks green, Partner Center says "In review" — Microsoft
simply blew through their 7-business-day claim; nothing for extport to
do and the ledger was correct throughout.

Two observations worth keeping: the daily stale reminders had been
firing since 08-09 and went unnoticed inside that week's alarm-email
noise — signal drowned by noise is the operational cost invariant 5's
work exists to pay down. And the draft-stall is undetectable by API
forever (Edge exposes no per-version status; request declined
upstream), so the reminder → human Partner Center check → branch on
"In draft" vs "In review" IS the designed runbook, not a workaround.

### 2026-08-10 — Gemini Exporter edge: superseded row vs. in-flight submit

Two pushes 110 seconds apart. The first push's Edge submit was accepted
store-side but its invocation died before recording it; the second push
superseded the still-`queued` row as skipped. Edge's API can never
report the in-review version (invariant 8), so every later tick tried to
submit v0.0.8 into the occupied slot and got `InProgressSubmission` —
which was then treated as an error (invariant 4).

Fix: `124294a` (InProgressSubmission → `waiting`). The same mapping
retroactively explains the 2026-08-05 Twitter Blocker error→recovered
noise pair.

### 2026-08-09 — phantom analytics version "1.0"

A prober replayed the public ping endpoint against two extensions with a
WebView-style iOS UA and placeholder version "1.0", minting a phantom
install and a "1.0" series in the version chart of an extension with no
iOS build. Raw pings being kept made the diagnosis take minutes
(invariant 9). Cleanup note: rollups read WAE, which is immutable — a
deleted D1 ping's WAU tail re-materializes nightly until it ages out of
the 7-day window; delete the `analytics_daily` rows after that, not
before.

Fix: `9a0762c` (drop pings whose UA parses to no known browser).

### 2026-08-08/09 — store-side 5xx storms → error-email fanout

ASC 500 storms (also 2026-07-25/26) and an AMO-wide 503 outage crossed
every settled target the sweep polled and fanned out one transition
email per target — seven emails about work that did not exist, plus idle
polling burning AMO's rate budget (a real 429 throttled a genuine
publish on 2026-07-30). Invariant 5.

Fix: `2c4095f` (the routine sweep leaves settled targets alone; scoped
runs and erroring/unbaselined targets still poll).

### 2026-08-08 — BilingualTube edge: duplicate submissions

The 2-minute lock staleness window was shorter than one legitimate Edge
submit, so the next cron reclaimed a live lock and ran a second
concurrent submit — Partner Center ended up with two submissions for one
version. Invariant 3.

Fix: `bd5de7f` (staleness window 2 → 10 minutes).

### Earlier, same family

- `180b425` — a store reporting an already-online version as in-review
  must not mint a duplicate in_review row (Scrub v0.0.17 chrome, slot
  blocked forever).
- `fbdf748` — never upload into a store that already has a review open.
- `08a94dd` — auto-withdraw removed entirely: cancelling a store review
  extport didn't start is never safe.
