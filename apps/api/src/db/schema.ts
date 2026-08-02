import type { TenantSettings } from '@extport/shared'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// No SQL-level FOREIGN KEY constraints anywhere in this schema — every
// "references" relationship below (tenantId, extensionId, artifactId, etc.)
// is enforced by the write paths in routes/ and reconcile/, the same way ids
// and default values already are. Two reasons: D1's remote backend doesn't
// reliably defer FK checks across the DROP-TABLE-and-rename SQLite normally
// uses to change a column (nullability, type, adding a constraint) — see the
// migration 0007 postmortem and migration 0008, which hit and then removed
// this entirely — so every future schema change to a referenced table was a
// landmine. And the cascade behavior FKs would normally buy isn't even in
// use: D1 doesn't enforce it either way, so dependent cleanup (e.g.
// extensions' DELETE handler) was already hand-written application code.
const now = () => new Date().toISOString()

const timestamps = {
  createdAt: text('created_at').notNull().$defaultFn(now),
  updatedAt: text('updated_at').notNull().$defaultFn(now).$onUpdateFn(now),
}

// ===== 租户与账户 =====

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  plan: text('plan', { enum: ['free', 'starter', 'pro'] }).notNull().$defaultFn(() => 'free'),
  // Closed beta: new signups land 'pending' and are manually flipped to
  // 'active' — see middleware/auth.ts's requireActiveTenant. Migration 0010
  // backfilled every pre-existing tenant to 'active' so this only gates
  // signups from that point forward.
  status: text('status', { enum: ['pending', 'active'] }).notNull().$defaultFn(() => 'pending'),
  settings: text('settings', { mode: 'json' }).$type<TenantSettings>().notNull().$defaultFn(() => ({})),
  // Envelope encryption: per-tenant DEK, wrapped by the versioned master KEK.
  dekEncrypted: text('dek_encrypted').notNull(),
  dekKeyVersion: integer('dek_key_version').notNull().$defaultFn(() => 1),
  ...timestamps,
})

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    authProvider: text('auth_provider').notNull(),
    authSubject: text('auth_subject').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_auth_idx').on(t.authProvider, t.authSubject),
    index('users_tenant_idx').on(t.tenantId),
  ],
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex('sessions_token_idx').on(t.tokenHash)],
)

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    last4: text('last4').notNull(),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('api_keys_hash_idx').on(t.keyHash),
    index('api_keys_tenant_idx').on(t.tenantId),
  ],
)

// `extport login`'s loopback flow: the dashboard mints a real API key and a
// short-lived one-time code standing in for it (POST /cli-auth/start), the
// CLI's local callback server receives the code from the browser redirect
// and exchanges it server-side for the real key (POST /cli-auth/exchange) —
// the key itself never appears in a URL a browser would keep in history.
// Deliberately holds the plaintext key, unlike api_keys' hash-only storage:
// this row's whole job is to hand that plaintext back out, exactly once,
// within minutes, then it's deleted.
export const cliAuthExchanges = sqliteTable('cli_auth_exchanges', {
  code: text('code').primaryKey(),
  apiKey: text('api_key').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(now),
})

// ===== 扩展(一等实体) =====

export const extensions = sqliteTable(
  'extensions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    iconUrl: text('icon_url'),
    // Publishing has no extension-level switch: configuring a store target IS
    // the opt-in, and pausing is per-target (publish_targets.enabled).
    // Licensing stays opt-in because it changes end-user runtime behavior.
    licensingEnabled: integer('licensing_enabled', { mode: 'boolean' }).notNull().$defaultFn(() => false),
    ...timestamps,
  },
  (t) => [
    // The name doubles as the licensing verification key (frozen while
    // licensingEnabled) — one entity, one key, so it's unique per tenant.
    uniqueIndex('extensions_name_idx').on(t.tenantId, t.name),
    index('extensions_tenant_idx').on(t.tenantId),
  ],
)

// ===== Publishing 模块 =====

export const storeCredentials = sqliteTable(
  'store_credentials',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'safari'] }).notNull(),
    label: text('label').notNull().$defaultFn(() => ''),
    // Last four characters of the most identifying secret field — the only
    // plaintext-derived value ever stored; the UI shows nothing else.
    hint: text('hint').notNull().$defaultFn(() => ''),
    // Credential JSON encrypted with the tenant DEK; plaintext never touches D1.
    encryptedPayload: text('encrypted_payload').notNull(),
    keyVersion: integer('key_version').notNull().$defaultFn(() => 1),
    // Edge API keys expire — used to drive rotation reminders.
    expiresAt: text('expires_at'),
    lastVerifiedAt: text('last_verified_at'),
    status: text('status', { enum: ['active', 'invalid', 'expiring'] }).notNull().$defaultFn(() => 'active'),
    ...timestamps,
  },
  (t) => [index('store_credentials_tenant_idx').on(t.tenantId)],
)

export const publishTargets = sqliteTable(
  'publish_targets',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    extensionId: text('extension_id').notNull(),
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'safari'] }).notNull(),
    storeItemId: text('store_item_id').notNull(),
    // Edge only: Partner Center's Submission API needs storeItemId to be the
    // internal GUID Product ID, but its public store-detail page (used as a
    // getState fallback, since the Submission API can't query status at all)
    // is keyed by the store-facing crx id instead — two different Microsoft
    // ID namespaces for the same listing. Unused by every other store.
    crxId: text('crx_id'),
    // Safari only: the platforms this target's App Store Connect app
    // actually has (e.g. ['macos'] for a macOS-only app). Null = every
    // platform the adapter declares (StoreAdapter.platforms) — the
    // historical default, still correct for every universal Safari app.
    // Set explicitly so reconcile stops polling appStoreVersions for a
    // platform that will never have one; see docs/safari-pipeline.md.
    platforms: text('platforms', { mode: 'json' }).$type<string[]>(),
    credentialId: text('credential_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().$defaultFn(() => true),
    // Operational health, not business state — never touches a specific
    // version's lifecycle. Cleared on the next tick that gets past getState().
    lastReconciledAt: text('last_reconciled_at'),
    lastErrorDetail: text('last_error_detail'),
    lastErrorAt: text('last_error_at'),
    // Claimed by whichever reconcile invocation (cron, post-push, "reconcile
    // now", post-add-target — see runReconciliation's doc comment) gets to
    // this target first, so a second concurrent invocation doesn't also
    // submit to the real store or double-send the error email. Cleared when
    // that invocation finishes; treated as stale and reclaimable after
    // RECONCILE_LOCK_STALE_MS if a Worker died mid-reconcile without
    // clearing it.
    reconcilingSince: text('reconciling_since'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('publish_targets_ext_store_idx').on(t.extensionId, t.store),
    index('publish_targets_tenant_idx').on(t.tenantId),
  ],
)

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    extensionId: text('extension_id').notNull(),
    version: text('version').notNull(),
    // null = universal zip for all stores; set = store-specific build.
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'safari'] }),
    source: text('source', { enum: ['github_release', 'cli_upload'] }).notNull(),
    // Empty string (never null — see migration 0007's comment for why) for a
    // store whose adapter declares requiresArtifact: false (Safari — its
    // binary reaches the store directly; this row only pins the version).
    // sha256 stays '' right alongside it; size is 0.
    r2Key: text('r2_key').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
    // Firefox only: AMO requires source for bundled/minified submissions —
    // a companion zip alongside the main one, both pinned to the same push.
    sourceR2Key: text('source_r2_key'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('artifacts_ext_version_store_idx').on(t.extensionId, t.version, t.store),
    index('artifacts_tenant_idx').on(t.tenantId),
    index('artifacts_ext_idx').on(t.extensionId),
  ],
)

// One row per (extension, store, version) push — the row's status moves
// through its lifecycle in place instead of being reconstructed from a
// separate event log. At most one 'queued' and one 'in_review' row may be
// active at a time per (extension, store); that invariant is enforced by the
// write path (see routes/artifacts.ts and reconcile/run.ts), not by SQLite.
//
//   queued ──submit succeeds──▶ in_review ──store confirms live──▶ online
//     │                            │
//     │                            └──store rejects──▶ rejected
//     │
//     └──superseded by a newer push, or already older than what's
//        live/in-review at push time──▶ skipped
//
// This table is the single source of truth for both "what's happening now"
// (query the active rows) and "what happened" (the Timeline is just this
// table ordered by time) — there is no separate current-state cache to keep
// in sync.
export const deploymentVersions = sqliteTable(
  'deployment_versions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    extensionId: text('extension_id').notNull(),
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'safari'] }).notNull(),
    version: text('version').notNull(),
    // Safari only: one App Store Connect app spans macOS and iOS with fully
    // independent review timelines, so each platform runs its own lifecycle
    // (docs/safari-pipeline.md). Null for every single-lifecycle store. The
    // "at most one active queued + one in_review" invariant is per
    // (extension, store, platform).
    platform: text('platform', { enum: ['macos', 'ios'] }),
    // null = this row wasn't pushed through extport — it's a baseline the
    // reconciler observed already live when a store target was first added
    // (or a manual publish that happened outside extport).
    artifactId: text('artifact_id'),
    status: text('status', {
      enum: ['queued', 'in_review', 'online', 'rejected', 'skipped'],
    }).notNull().$defaultFn(() => 'queued'),
    statusDetail: text('status_detail'),
    // Set once, when the row enters in_review — drives the stale_review
    // threshold and is never overwritten by later transitions.
    submittedAt: text('submitted_at'),
    ...timestamps,
  },
  (t) => [
    index('deployment_versions_ext_store_idx').on(t.extensionId, t.store),
    index('deployment_versions_ext_store_status_idx').on(t.extensionId, t.store, t.status),
    index('deployment_versions_tenant_idx').on(t.tenantId),
  ],
)

// Everything that's NOT about a specific version's lifecycle — that lives on
// deployment_versions.status instead. Only two things are left here.
export const publishEvents = sqliteTable(
  'publish_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    extensionId: text('extension_id').notNull(),
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'safari'] }).notNull(),
    type: text('type', { enum: ['error', 'recovered', 'stale_review'] }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().$defaultFn(() => ({})),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (t) => [
    index('publish_events_tenant_idx').on(t.tenantId),
    index('publish_events_ext_idx').on(t.extensionId, t.createdAt),
  ],
)

// ===== Licensing 模块(Phase 2 实现,schema 先落地) =====

export const plans = sqliteTable(
  'plans',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    extensionId: text('extension_id').notNull(),
    // 'basic' / 'pro' / ... — 'free' is reserved for the SDK's unpaid tier.
    // What the SDK sends as `productName` is cross-checked against
    // extensions.name (frozen while licensingEnabled) — a plan has no name
    // of its own. The end-state key is extensionId; see docs/licensing.md.
    tier: text('tier').notNull(),
    entitlementType: text('entitlement_type', {
      enum: ['perpetual', 'balance', 'recurring'],
    }).notNull().$defaultFn(() => 'perpetual'),
    maxActivations: integer('max_activations').notNull().$defaultFn(() => 3),
    ...timestamps,
  },
  (t) => [
    index('plans_tenant_idx').on(t.tenantId),
    uniqueIndex('plans_ext_tier_idx').on(t.extensionId, t.tier),
  ],
)

export const licenses = sqliteTable(
  'licenses',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    planId: text('plan_id').notNull(),
    key: text('key').notNull(),
    buyerEmail: text('buyer_email').notNull(),
    entitlementType: text('entitlement_type', {
      enum: ['perpetual', 'balance', 'recurring'],
    }).notNull().$defaultFn(() => 'perpetual'),
    // Snapshot at issuance — later plan edits must not retroactively
    // change already-sold licenses.
    maxActivations: integer('max_activations').notNull(),
    status: text('status', { enum: ['active', 'locked', 'refunded'] }).notNull().$defaultFn(() => 'active'),
    source: text('source', { enum: ['stripe_webhook', 'manual', 'imported'] }).notNull(),
    // Sale amount snapshot (Stripe's smallest currency unit) — the basis for
    // future percentage-based licensing billing. Null for manual/imported
    // rows until backfilled from the provider.
    amountTotal: integer('amount_total'),
    currency: text('currency'),
    // Billing address country (ISO 3166-1 alpha-2), from the Checkout
    // Session's customer_details — only populated when the tenant's
    // Payment Link collects a billing address. Null for manual/imported
    // rows and for sessions that didn't collect one.
    country: text('country'),
    sourceRef: text('source_ref'),
    // Stripe Checkout Session id (cs_…), stored at fulfillment for the
    // success page's time-boxed lookup — extport holds no tenant API key
    // to resolve cs → pi later. sourceRef stays the PaymentIntent (what
    // refund events reference).
    checkoutSessionId: text('checkout_session_id'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('licenses_key_idx').on(t.key),
    index('licenses_tenant_idx').on(t.tenantId),
    index('licenses_buyer_idx').on(t.tenantId, t.buyerEmail),
    // Keyset pagination for the dashboard's license list.
    index('licenses_plan_created_idx').on(t.planId, t.createdAt),
    // Webhook idempotency + refund lookup. SQLite unique indexes admit any
    // number of NULLs, so manual licenses (no sourceRef) are unaffected.
    uniqueIndex('licenses_source_ref_idx').on(t.sourceRef),
    uniqueIndex('licenses_checkout_session_idx').on(t.checkoutSessionId),
  ],
)

export const activations = sqliteTable(
  'activations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    licenseId: text('license_id').notNull(),
    deviceFingerprint: text('device_fingerprint').notNull(),
    lastHeartbeatAt: text('last_heartbeat_at'),
    activatedAt: text('activated_at').notNull().$defaultFn(now),
    // A seat is an activation with releasedAt IS NULL. Re-activation of a
    // known fingerprint reuses the row (clearing releasedAt) rather than
    // inserting a duplicate.
    releasedAt: text('released_at'),
    ipHint: text('ip_hint'),
    uaHint: text('ua_hint'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('activations_license_device_idx').on(t.licenseId, t.deviceFingerprint),
    index('activations_tenant_idx').on(t.tenantId),
  ],
)

export const licenseEvents = sqliteTable(
  'license_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    licenseId: text('license_id').notNull(),
    // Heartbeats are deliberately not events.
    type: text('type', {
      enum: ['issued', 'activated', 'seat_released', 'revoked', 'reset'],
    }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().$defaultFn(() => ({})),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (t) => [index('license_events_license_idx').on(t.licenseId, t.createdAt)],
)

// One payment-provider credential per (tenant, provider) — the Stripe
// webhook signing secret, envelope-encrypted exactly like store
// credentials. The tenant's Stripe account itself stays theirs; extport
// only verifies webhook signatures with this. See docs/licensing.md.
export const paymentCredentials = sqliteTable(
  'payment_credentials',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    provider: text('provider', { enum: ['stripe'] }).notNull(),
    // Last four characters of the secret — the only plaintext-derived value stored.
    hint: text('hint').notNull(),
    // { webhookSecret } encrypted with the tenant DEK.
    encryptedPayload: text('encrypted_payload').notNull(),
    keyVersion: integer('key_version').notNull().$defaultFn(() => 1),
    ...timestamps,
  },
  (t) => [uniqueIndex('payment_credentials_tenant_provider_idx').on(t.tenantId, t.provider)],
)

// ===== 买家门户(slice C) =====

// Magic-link sign-in for the buyer portal. Identity is just an email —
// licenses already carry buyerEmail, and nothing needs a profile row.
// The emailed link carries a one-time code, hashed at rest exactly like
// session tokens; verifying it mints a buyer session.
export const magicLinks = sqliteTable(
  'magic_links',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    usedAt: text('used_at'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (t) => [
    uniqueIndex('magic_links_code_idx').on(t.codeHash),
    index('magic_links_email_idx').on(t.email),
  ],
)

export const buyerSessions = sqliteTable(
  'buyer_sessions',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (t) => [
    uniqueIndex('buyer_sessions_token_idx').on(t.tokenHash),
    index('buyer_sessions_email_idx').on(t.email),
  ],
)

// ===== Analytics =====
// See docs/analytics-design.md. The wire protocol is a single daily ping;
// install/update/active/departure are all server-side inferences over pings.

// One row per install, keyed by the client-generated random UUID — the
// pseudonymous identity, deliberately unlinked from licensing's
// deviceFingerprint. This table is what keeps the exact metrics (MAU,
// current version distribution, departures) independent of the raw window.
export const analyticsInstalls = sqliteTable(
  'analytics_installs',
  {
    extensionId: text('extension_id').notNull(),
    installId: text('install_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    browser: text('browser').notNull(),
    // Day granularity (UTC YYYY-MM-DD) throughout — every metric is daily,
    // and the coarse timestamps are part of the privacy story.
    firstSeen: text('first_seen').notNull(),
    lastSeen: text('last_seen').notNull(),
    lastVersion: text('last_version').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.extensionId, t.installId] }),
    // Departure confirmation scans by exact last-seen day; MAU by range.
    index('analytics_installs_last_seen_idx').on(t.lastSeen),
    index('analytics_installs_ext_seen_idx').on(t.extensionId, t.lastSeen),
    index('analytics_installs_ext_first_idx').on(t.extensionId, t.firstSeen),
  ],
)

// Raw accepted pings, kept 90 days (pruned by our own cron) so rollups can
// be recomputed after a bucketing bug — never read by product features.
export const analyticsPings = sqliteTable(
  'analytics_pings',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    extensionId: text('extension_id').notNull(),
    installId: text('install_id').notNull(),
    date: text('date').notNull(),
    browser: text('browser').notNull(),
    version: text('version').notNull(),
    os: text('os'),
    country: text('country'),
    language: text('language'),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  // The nightly rollup and the 90-day prune both scan by day.
  (t) => [index('analytics_pings_date_idx').on(t.date)],
)

// Permanent single-dimension daily series — what every chart reads.
// dim 'total' rows carry the headline metrics; dimension rows carry dau
// only (store consoles never cross dimensions, so neither do we).
export const analyticsDaily = sqliteTable(
  'analytics_daily',
  {
    tenantId: text('tenant_id').notNull(),
    extensionId: text('extension_id').notNull(),
    date: text('date').notNull(),
    browser: text('browser').notNull(),
    dim: text('dim', { enum: ['total', 'version', 'country', 'language', 'os'] }).notNull(),
    dimValue: text('dim_value').notNull(),
    dau: integer('dau').notNull().default(0),
    // Rolling 7-day distinct actives ending on `date`, computed from raw
    // pings (immutable, so exact — no snapshot drift). The headline
    // activity metric: matches the CWS console's weekly users, and a 7-day
    // window absorbs the day-level undercount inherent to event-driven
    // pings (a running-but-idle browser can miss a day, rarely a week).
    wau: integer('wau').notNull().default(0),
    installs: integer('installs').notNull().default(0),
    // Attributed to the last-seen day and only written once confirmed
    // (30 days of silence) — the chart's trailing month stays blank.
    departures: integer('departures').notNull().default(0),
    // Rolling 30-day MAU snapshot as of `date` — not derivable later.
    mau: integer('mau').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.extensionId, t.date, t.browser, t.dim, t.dimValue] }),
    index('analytics_daily_series_idx').on(t.extensionId, t.dim, t.date),
  ],
)

export type Tenant = typeof tenants.$inferSelect
export type User = typeof users.$inferSelect
export type Session = typeof sessions.$inferSelect
export type ApiKey = typeof apiKeys.$inferSelect
export type Extension = typeof extensions.$inferSelect
export type StoreCredential = typeof storeCredentials.$inferSelect
export type PublishTarget = typeof publishTargets.$inferSelect
export type Artifact = typeof artifacts.$inferSelect
export type DeploymentVersion = typeof deploymentVersions.$inferSelect
export type PublishEvent = typeof publishEvents.$inferSelect
export type Plan = typeof plans.$inferSelect
export type License = typeof licenses.$inferSelect
export type Activation = typeof activations.$inferSelect
export type LicenseEvent = typeof licenseEvents.$inferSelect
export type PaymentCredential = typeof paymentCredentials.$inferSelect
export type MagicLink = typeof magicLinks.$inferSelect
export type BuyerSession = typeof buyerSessions.$inferSelect
export type AnalyticsInstall = typeof analyticsInstalls.$inferSelect
export type AnalyticsPing = typeof analyticsPings.$inferSelect
export type AnalyticsDailyRow = typeof analyticsDaily.$inferSelect
