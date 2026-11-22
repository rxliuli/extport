# Project Rules

## Git Push & Production Deployments

- Pushing to `main` automatically deploys to production via Cloudflare Workers Builds.
- **Never** run `git push` unless the user explicitly asks to push. Commit locally only when appropriate and wait for explicit confirmation before pushing.

## Deployment & D1 Migrations

- Production D1 migrations are applied automatically during CI deployment.
- Do **not** run `pnpm db:migrate:remote` or `wrangler d1 migrations apply ... --remote` manually against the production database. Only generate and commit migration files (`pnpm db:generate`) and let CI apply them on deploy.

## Mandatory Real-Browser & Real-Sandbox Verification

- **Never** declare a UI, API, auth, billing, or webhook change "done" based solely on unit tests (`vitest`) or mock-backed E2E tests (`mock-stripe.mjs`). Unit and mock tests are necessary baselines, **not** proof that the feature works end-to-end.
- Before reporting completion to the user, you **must** verify the change in the real local environment:
  1. Apply any new migrations locally (`pnpm --filter @extport/api db:migrate:local`) and ensure both local dev servers (`localhost:5173` dashboard and `localhost:8787` API) are running the latest code and `.dev.vars`.
  2. Open the real browser (via Chrome DevTools MCP) at `http://localhost:5173` and click through the full user journey against real sandbox services (e.g. real Stripe Sandbox OAuth, Checkout, Subscription Schedules, Cancel/Resume) — including edge/state transitions.
  3. Check HTTP responses, persisted local D1 state, and browser console messages (zero unexpected errors).
- If any real-environment step is genuinely blocked (e.g. requires manual 2FA or missing external credentials), explicitly state what was **not** verified in the real environment rather than claiming the task is complete.
