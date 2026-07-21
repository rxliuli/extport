import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
  settingsJson: text('settings_json').notNull().$defaultFn(() => '{}'),
  // Envelope encryption: per-tenant DEK, wrapped by the versioned master KEK.
  dekEncrypted: text('dek_encrypted').notNull(),
  dekKeyVersion: integer('dek_key_version').notNull().$defaultFn(() => 1),
  ...timestamps,
})

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
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
    userId: text('user_id').notNull().references(() => users.id),
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
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
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

// ===== 扩展(一等实体) =====

export const extensions = sqliteTable(
  'extensions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    iconUrl: text('icon_url'),
    // Publishing has no extension-level switch: configuring a store target IS
    // the opt-in, and pausing is per-target (publish_targets.enabled).
    // Licensing stays opt-in because it changes end-user runtime behavior.
    licensingEnabled: integer('licensing_enabled', { mode: 'boolean' }).notNull().$defaultFn(() => false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('extensions_slug_idx').on(t.tenantId, t.slug),
    index('extensions_tenant_idx').on(t.tenantId),
  ],
)

// ===== Publishing 模块 =====

export const storeCredentials = sqliteTable(
  'store_credentials',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
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
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    extensionId: text('extension_id').notNull().references(() => extensions.id),
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'safari'] }).notNull(),
    storeItemId: text('store_item_id').notNull(),
    // Edge only: Partner Center's Submission API needs storeItemId to be the
    // internal GUID Product ID, but its public store-detail page (used as a
    // getState fallback, since the Submission API can't query status at all)
    // is keyed by the store-facing crx id instead — two different Microsoft
    // ID namespaces for the same listing. Unused by every other store.
    crxId: text('crx_id'),
    credentialId: text('credential_id').notNull().references(() => storeCredentials.id),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().$defaultFn(() => true),
    // Operational health, not business state — never touches a specific
    // version's lifecycle. Cleared on the next tick that gets past getState().
    lastReconciledAt: text('last_reconciled_at'),
    lastErrorDetail: text('last_error_detail'),
    lastErrorAt: text('last_error_at'),
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
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    extensionId: text('extension_id').notNull().references(() => extensions.id),
    version: text('version').notNull(),
    // null = universal zip for all stores; set = store-specific build.
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'safari'] }),
    source: text('source', { enum: ['github_release', 'cli_upload'] }).notNull(),
    r2Key: text('r2_key').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
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
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    extensionId: text('extension_id').notNull().references(() => extensions.id),
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
    artifactId: text('artifact_id').references(() => artifacts.id),
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
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    extensionId: text('extension_id').notNull().references(() => extensions.id),
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'safari'] }).notNull(),
    type: text('type', { enum: ['error', 'recovered', 'stale_review'] }).notNull(),
    payloadJson: text('payload_json').notNull().$defaultFn(() => '{}'),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (t) => [
    index('publish_events_tenant_idx').on(t.tenantId),
    index('publish_events_ext_idx').on(t.extensionId, t.createdAt),
  ],
)

// ===== Licensing 模块(Phase 2 实现,schema 先落地) =====

export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    extensionId: text('extension_id').notNull().references(() => extensions.id),
    name: text('name').notNull(),
    entitlementType: text('entitlement_type', {
      enum: ['perpetual', 'balance', 'recurring'],
    }).notNull().$defaultFn(() => 'perpetual'),
    maxActivations: integer('max_activations').notNull().$defaultFn(() => 3),
    stripeMetadataKey: text('stripe_metadata_key'),
    ...timestamps,
  },
  (t) => [index('products_tenant_idx').on(t.tenantId)],
)

export const licenses = sqliteTable(
  'licenses',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    productId: text('product_id').notNull().references(() => products.id),
    key: text('key').notNull(),
    buyerEmail: text('buyer_email').notNull(),
    entitlementType: text('entitlement_type', {
      enum: ['perpetual', 'balance', 'recurring'],
    }).notNull().$defaultFn(() => 'perpetual'),
    balance: integer('balance'),
    status: text('status', { enum: ['active', 'locked', 'refunded'] }).notNull().$defaultFn(() => 'active'),
    source: text('source', { enum: ['stripe_webhook', 'manual', 'imported'] }).notNull(),
    sourceRef: text('source_ref'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('licenses_key_idx').on(t.key),
    index('licenses_tenant_idx').on(t.tenantId),
    index('licenses_buyer_idx').on(t.tenantId, t.buyerEmail),
  ],
)

export const activations = sqliteTable(
  'activations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    licenseId: text('license_id').notNull().references(() => licenses.id),
    deviceFingerprint: text('device_fingerprint').notNull(),
    lastHeartbeatAt: text('last_heartbeat_at'),
    activatedAt: text('activated_at').notNull().$defaultFn(now),
    releasedAt: text('released_at'),
    ipHint: text('ip_hint'),
    uaHint: text('ua_hint'),
    ...timestamps,
  },
  (t) => [
    index('activations_license_idx').on(t.licenseId),
    index('activations_tenant_idx').on(t.tenantId),
  ],
)

export const licenseEvents = sqliteTable(
  'license_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    licenseId: text('license_id').notNull().references(() => licenses.id),
    type: text('type', {
      enum: ['issued', 'activated', 'reset', 'locked', 'heartbeat_expired'],
    }).notNull(),
    payloadJson: text('payload_json').notNull().$defaultFn(() => '{}'),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (t) => [index('license_events_license_idx').on(t.licenseId, t.createdAt)],
)

export const tenantSigningKeys = sqliteTable(
  'tenant_signing_keys',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    privateKeyEncrypted: text('private_key_encrypted').notNull(),
    publicKey: text('public_key').notNull(),
    keyVersion: integer('key_version').notNull().$defaultFn(() => 1),
    status: text('status', { enum: ['active', 'retired'] }).notNull().$defaultFn(() => 'active'),
    ...timestamps,
  },
  (t) => [index('tenant_signing_keys_tenant_idx').on(t.tenantId)],
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
