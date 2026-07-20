import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const now = () => new Date()

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now).$onUpdateFn(now),
}

// ===== 租户与账户 =====

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  plan: text('plan', { enum: ['free', 'starter', 'pro'] }).notNull().default('free'),
  settingsJson: text('settings_json').notNull().default('{}'),
  // Envelope encryption: per-tenant DEK, wrapped by the versioned master KEK.
  dekEncrypted: text('dek_encrypted').notNull(),
  dekKeyVersion: integer('dek_key_version').notNull().default(1),
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
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
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
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
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
    publishingEnabled: integer('publishing_enabled', { mode: 'boolean' }).notNull().default(false),
    licensingEnabled: integer('licensing_enabled', { mode: 'boolean' }).notNull().default(false),
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
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'apple'] }).notNull(),
    label: text('label').notNull().default(''),
    // Last four characters of the most identifying secret field — the only
    // plaintext-derived value ever stored; the UI shows nothing else.
    hint: text('hint').notNull().default(''),
    // Credential JSON encrypted with the tenant DEK; plaintext never touches D1.
    encryptedPayload: text('encrypted_payload').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    // Edge API keys expire — used to drive rotation reminders.
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    lastVerifiedAt: integer('last_verified_at', { mode: 'timestamp_ms' }),
    status: text('status', { enum: ['active', 'invalid', 'expiring'] }).notNull().default('active'),
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
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'apple'] }).notNull(),
    storeItemId: text('store_item_id').notNull(),
    credentialId: text('credential_id').notNull().references(() => storeCredentials.id),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
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
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'apple'] }),
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

export const deploymentStates = sqliteTable(
  'deployment_states',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    extensionId: text('extension_id').notNull().references(() => extensions.id),
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'apple'] }).notNull(),
    desiredVersion: text('desired_version'),
    liveVersion: text('live_version'),
    inReviewVersion: text('in_review_version'),
    status: text('status', {
      enum: ['synced', 'submitting', 'in_review', 'rejected', 'blocked', 'error'],
    }).notNull().default('synced'),
    statusDetail: text('status_detail'),
    lastReconciledAt: integer('last_reconciled_at', { mode: 'timestamp_ms' }),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('deployment_states_ext_store_idx').on(t.extensionId, t.store),
    index('deployment_states_tenant_idx').on(t.tenantId),
  ],
)

export const publishEvents = sqliteTable(
  'publish_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    extensionId: text('extension_id').notNull().references(() => extensions.id),
    store: text('store', { enum: ['chrome', 'firefox', 'edge', 'apple'] }).notNull(),
    type: text('type', {
      enum: ['submitted', 'approved', 'rejected', 'withdrawn', 'error', 'stale_review'],
    }).notNull(),
    payloadJson: text('payload_json').notNull().default('{}'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
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
    }).notNull().default('perpetual'),
    maxActivations: integer('max_activations').notNull().default(3),
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
    }).notNull().default('perpetual'),
    balance: integer('balance'),
    status: text('status', { enum: ['active', 'locked', 'refunded'] }).notNull().default('active'),
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
    lastHeartbeatAt: integer('last_heartbeat_at', { mode: 'timestamp_ms' }),
    activatedAt: integer('activated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
    releasedAt: integer('released_at', { mode: 'timestamp_ms' }),
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
    payloadJson: text('payload_json').notNull().default('{}'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
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
    keyVersion: integer('key_version').notNull().default(1),
    status: text('status', { enum: ['active', 'retired'] }).notNull().default('active'),
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
export type DeploymentState = typeof deploymentStates.$inferSelect
export type PublishEvent = typeof publishEvents.$inferSelect
