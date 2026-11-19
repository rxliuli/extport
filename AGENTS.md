# Project Rules

## Deployment & D1 Migrations

- Production D1 migrations are applied automatically during CI deployment.
- Do **not** run `pnpm db:migrate:remote` or `wrangler d1 migrations apply ... --remote` manually against the production database. Only generate and commit migration files (`pnpm db:generate`) and let CI apply them on deploy.
