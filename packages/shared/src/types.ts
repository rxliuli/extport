export const STORES = ['chrome', 'firefox', 'edge', 'safari'] as const
export type Store = (typeof STORES)[number]

/**
 * The current, derived-at-read-time status for a (extension, store) target.
 * Not stored anywhere — computed from deployment_versions' active rows (see
 * apps/api's reconcile/status derivation) plus publish_targets.lastErrorDetail,
 * which takes priority over everything else since it means reconcile couldn't
 * even get far enough to know what a version is doing.
 */
export type DeploymentStatus = 'synced' | 'queued' | 'in_review' | 'blocked' | 'rejected' | 'error'

/**
 * One failure behind publish_targets.lastErrorDetail, kept structured so the
 * dashboard can say what happened in a sentence (and show each Safari
 * platform only its own failure) instead of echoing the raw store response.
 * lastErrorDetail stays the "is this target erroring" flag and the email
 * text; this is display data only.
 */
export interface TargetError {
  /** The Safari lifecycle that failed; null = the whole target (credential problems, every non-Safari store). */
  platform: string | null
  /** HTTP status the store API answered with — null when the failure wasn't a store API response. */
  status: number | null
  /** The store's machine-readable code from the response body, when it sent one (ASC: UNEXPECTED_ERROR). */
  code: string | null
  /** Full message, raw store body included — for the "raw details" disclosure. */
  message: string
}

/**
 * Only things that aren't about a specific version's lifecycle — see
 * deployment_versions.status for that. error/recovered are transition
 * markers (entering and leaving the error state), never per-tick records.
 */
export type PublishEventType = 'error' | 'recovered' | 'stale_review'

export type CredentialHealth = 'active' | 'invalid' | 'expiring'

export type ArtifactSource = 'github_release' | 'cli_upload'

export type EntitlementType = 'perpetual' | 'balance' | 'recurring'

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'expired'] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export type Plan = 'free' | 'starter' | 'pro'

export interface PlanLimits {
  /** null = unlimited */
  maxExtensions: number | null
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { maxExtensions: 3 },
  starter: { maxExtensions: 5 },
  pro: { maxExtensions: null },
}

/** Tenant-level settings stored in tenants.settings. */
export interface TenantSettings {
  staleReviewDays?: Partial<Record<Store, number>>
  /**
   * Where the tenant's buyers go for help — an https:// page or a mailto:
   * address. Shown in the buyer portal and the license email; unset means
   * no link at all (extport never falls back to the account email).
   */
  supportUrl?: string
  /**
   * Stripe No-code Customer Portal Login Link (https://billing.stripe.com/p/login/...).
   * Surfaced in subscription emails, the buyer portal, and entitlement API responses
   * so subscribers can manage or cancel their subscription without extport holding
   * any Stripe secret API key.
   */
  billingPortalUrl?: string
}

/** True for an absolute http(s) URL. */
export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

/** True for an absolute http(s) URL or a mailto: with an address. */
export function isValidSupportUrl(value: string): boolean {
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value)) return true
  return isValidHttpUrl(value)
}

export const DEFAULT_STALE_REVIEW_DAYS: Record<Store, number> = {
  chrome: 3,
  firefox: 3,
  edge: 10,
  safari: 3,
}
