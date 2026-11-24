export interface Me {
  authType: 'session' | 'api_key'
  tenant: { id: string; name: string; plan: string; status: 'pending' | 'active' }
  user: { id: string; email: string; displayName: string | null } | null
}

export type BillingMode = 'license' | 'subscription'

export interface Extension {
  id: string
  name: string
  licensingEnabled: boolean
  billingMode?: BillingMode | null
}

export type Store = 'chrome' | 'firefox' | 'edge' | 'safari'
/** The current, derived status for a (extension, store) target — see apps/api's reconcile/status.ts. */
export type DeploymentStatus = 'synced' | 'queued' | 'in_review' | 'blocked' | 'rejected' | 'error'

export type SafariPlatform = 'macos' | 'ios'

/** One failure behind a lifecycle's error status — see @extport/shared's TargetError. */
export interface TargetError {
  /** null = the whole target (credential problems, single-lifecycle stores). */
  platform: SafariPlatform | null
  /** HTTP status of the store API response; null when the failure wasn't one. */
  status: number | null
  /** The store's own error code, e.g. App Store Connect's UNEXPECTED_ERROR. */
  code: string | null
  /** Full message including the raw store response. */
  message: string
}

/**
 * One lifecycle's current state. Most stores have exactly one (platform
 * null); Safari has one per platform the app actually ships.
 */
export interface TargetLifecycle {
  platform: SafariPlatform | null
  /** Coarse summary — for at-a-glance color/priority only, never paired with a single version for display. */
  status: DeploymentStatus
  liveVersion: string | null
  inReviewVersion: string | null
  /** Only coexists with inReviewVersion when status is 'blocked'. */
  queuedVersion: string | null
  /** Only set while nothing newer has been pushed since the rejection. */
  rejectedVersion: string | null
  statusDetail: string | null
  /** ISO date string (Date -> JSON) */
  submittedAt: string | null
  /** Set only while status is 'error' — this lifecycle's own failure. */
  error: TargetError | null
}

export interface MatrixTarget {
  targetId: string
  store: Store
  enabled: boolean
  disabledSource: 'manual' | 'auto' | null
  disabledReason: string | null
  credentialLabel: string
  credentialStatus: 'active' | 'invalid' | 'expiring'
  lifecycles: TargetLifecycle[]
  /** ISO date string (Date -> JSON) */
  lastReconciledAt: string | null
}

export interface MatrixExtension {
  id: string
  name: string
  targets: MatrixTarget[]
}

export interface PublishTarget {
  id: string
  store: Store
  storeItemId: string
  /** Edge only — Partner Center's Submission API needs storeItemId to be the Product ID; this is the separate crx id its public status fallback needs. */
  crxId: string | null
  enabled: boolean
  /** Who flipped enabled off — 'auto' is reconcile pausing after two back-to-back rejections. */
  disabledSource: 'manual' | 'auto' | null
  disabledReason: string | null
  disabledAt: string | null
  credentialId: string
  credentialLabel: string
  credentialStatus: 'active' | 'invalid' | 'expiring'
  /** A reconcile holds this target right now ("Sync now" watches this to know when it's done). */
  reconciling: boolean
  /** Store developer console deep link (computed server-side — Chrome's needs the publisherId inside the encrypted credential). */
  consoleUrl: string
  lifecycles: (TargetLifecycle & { consoleUrl: string })[]
}

/** One row per (extension, store, version) push — the Timeline's main content. See apps/api's deployment_versions table. */
export interface DeploymentVersion {
  id: string
  store: Store
  /** Safari only: which of the app's platforms this lifecycle row belongs to. */
  platform: SafariPlatform | null
  version: string
  status: 'queued' | 'in_review' | 'online' | 'rejected' | 'skipped'
  statusDetail: string | null
  /** ISO date string (Date -> JSON) */
  submittedAt: string | null
  /** ISO date string (Date -> JSON) */
  createdAt: string
  /** ISO date string (Date -> JSON) */
  updatedAt: string
}

/** Only things that aren't about a specific version's lifecycle. */
export interface PublishEvent {
  id: string
  store: Store
  type: 'error' | 'recovered' | 'stale_review' | 'paused' | 'interrupted'
  payload: Record<string, unknown>
  /** ISO date string (Date -> JSON) */
  createdAt: string
}

export interface ApiKeyRow {
  id: string
  name: string
  masked: string
  /** ISO date string (Date -> JSON) */
  createdAt: string
  /** ISO date string (Date -> JSON) */
  lastUsedAt: string | null
}

export interface CredentialRow {
  id: string
  store: Store
  label: string
  hint: string
  status: 'active' | 'invalid' | 'expiring'
  /** ISO date string (Date -> JSON) */
  expiresAt: string | null
  /** ISO date string (Date -> JSON) */
  lastVerifiedAt: string | null
}

export type EntitlementType = 'perpetual' | 'balance' | 'recurring'
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired'
export type SubscriptionStatusFilter = SubscriptionStatus | 'canceling'

export type BillingInterval = 'one_time' | 'month' | 'year'

export interface Plan {
  id: string
  extensionId: string
  /** A plan has no name of its own — the extension it belongs to is its identity. */
  tier: string
  entitlementType: EntitlementType
  billingInterval: BillingInterval
  maxActivations: number
  currency: string
  amount: number
  active: boolean
  stripeProductId: string | null
  stripePriceId: string | null
  /** ISO date string (Date -> JSON) */
  createdAt: string
}

export interface LicenseRow {
  id: string
  planId: string
  key: string
  buyerEmail: string
  externalUserId: string | null
  entitlementType: EntitlementType
  status: 'active' | 'locked' | 'refunded'
  stripeSubscriptionId: string | null
  subscriptionStatus: SubscriptionStatus | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  maxActivations: number
  source: 'stripe_webhook' | 'manual' | 'imported'
  /** Smallest currency unit (e.g. cents); null for manual/imported rows not yet backfilled. */
  amountTotal: number | null
  currency: string | null
  // Joined by the API from the license's plan and extension — makes
  // cross-product views (the global Licenses page) self-contained.
  tier: string
  extensionId: string
  extensionName: string
  /** ISO date string (Date -> JSON) */
  createdAt: string
}

export interface ActivationRow {
  id: string
  deviceFingerprint: string
  /** ISO date string (Date -> JSON) */
  activatedAt: string
  /** ISO date string (Date -> JSON) */
  lastHeartbeatAt: string | null
  /** ISO date string (Date -> JSON) */
  releasedAt: string | null
  ipHint: string | null
  uaHint: string | null
  geoHint: string | null
}

export interface SubscriptionRow {
  id: string
  extensionId: string
  planId: string
  externalUserId: string | null
  buyerEmail: string
  stripeCustomerId: string | null
  stripeSubscriptionId: string
  checkoutSessionId: string | null
  status: SubscriptionStatus
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  pendingPlanId?: string | null
  pendingEffectiveAt?: string | null
  pendingPlan?: { tier: string; billingInterval: BillingInterval } | null
  amountTotal: number | null
  currency: string | null
  country: string | null
  tier: string
  billingInterval?: BillingInterval
  extensionName: string
  /** ISO date string (Date -> JSON) */
  createdAt: string
  /** ISO date string (Date -> JSON) */
  updatedAt: string
}

export interface SubscriptionsOverview {
  /** Dominant plan currency among active subscriptions — the currency MRR is reported in. */
  currency: string
  /** Estimated monthly recurring revenue in smallest currency unit (yearly plans normalized / 12). */
  mrr: number
  hasMultipleCurrencies: boolean
  counts: {
    active: number
    trialing: number
    pastDue: number
    canceling: number
    canceled: number
    expired: number
    total: number
  }
  newLast30d: number
  newPrev30d: number
}

export interface PaymentCredentialRow {
  id: string
  provider: 'stripe'
  stripeAccountId: string | null
  connected: boolean
  /** ISO date string (Date -> JSON) */
  createdAt: string
  /** ISO date string (Date -> JSON) */
  updatedAt: string
}

/** One analytics_daily row — see the API's /v1/analytics/series. */
export interface AnalyticsSeriesRow {
  date: string
  browser: string
  dimValue: string
  dau: number
  /** Rolling 7-day actives ending on `date` — the headline activity metric. Only on dim=total rows. */
  wau: number
  installs: number
}

/** A /series or /fleet/series response — rows plus the axis watermark. */
export interface AnalyticsSeries {
  rows: AnalyticsSeriesRow[]
  /**
   * The last fully-rolled-up day; charts end their x-axis here. A day past
   * it is not yet computed — drawing it would show a false zero (the rollup
   * runs at 00:15 UTC, so until then "yesterday" has no rows).
   */
  through: string
}

/** One breakdown slice; `value: null` is the folded "Other" tail. */
export interface DimensionShare {
  value: string | null
  wau: number
  share: number
}

export interface AnalyticsOverview {
  /** Latest-day rolling 7-day actives — the one activity figure every surface shows. */
  weeklyActives: number
  allTimeInstalls: number
  versions: { version: string; weeklyUsers: number }[]
  /** Ranked server-side off the same latest day as the figures above, so the cards can't disagree with them. */
  country: DimensionShare[]
  language: DimensionShare[]
  os: DimensionShare[]
}

/** Same idea as AnalyticsOverview but summed across every extension — no version breakdown, see the API's /v1/analytics/fleet/overview. */
export interface FleetAnalyticsOverview {
  weeklyActives: number
  allTimeInstalls: number
  extensionsReporting: number
}

/** One row of the fleet-wide per-extension ranking — see the API's /v1/analytics/fleet/extensions. */
export interface FleetExtensionAnalytics {
  extensionId: string
  name: string
  weeklyActives: number
  allTimeInstalls: number
}

export function isSafeHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const message = [body.error, body.reason, body.detail].filter(Boolean).join(' — ')
    throw new ApiError(res.status, message || `request failed (${res.status})`)
  }
  return body as T
}
