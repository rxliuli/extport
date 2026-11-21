# Project Rules

## Git Push & Production Deployments

- Pushing to `main` automatically deploys to production via Cloudflare Workers Builds.
- **Never** run `git push` unless the user explicitly asks to push. Commit locally only when appropriate and wait for explicit confirmation before pushing.

## Deployment & D1 Migrations

- Production D1 migrations are applied automatically during CI deployment.
- Do **not** run `pnpm db:migrate:remote` or `wrangler d1 migrations apply ... --remote` manually against the production database. Only generate and commit migration files (`pnpm db:generate`) and let CI apply them on deploy.
