export const STORES = ['chrome', 'firefox', 'edge', 'safari'] as const
export type Store = (typeof STORES)[number]

/**
 * The current, derived-at-read-time status for a (extension, store) target.
 * Not stored anywhere — computed from deployment_versions' active rows (see
 * apps/api's reconcile/status derivation) plus publish_targets.lastErrorDetail,
 * which takes priority over everything else since it means reconcile couldn't
 * even get far enough to know what a version is doing.
 */
export type DeploymentStatus =
  | 'synced'
  | 'queued'
  | 'in_review'
  | 'blocked'
  | 'rejected'
  | 'error'

/**
 * Only things that aren't about a specific version's lifecycle — see
 * deployment_versions.status for that. error/recovered are transition
 * markers (entering and leaving the error state), never per-tick records.
 */
export type PublishEventType = 'error' | 'recovered' | 'stale_review'

export type CredentialHealth = 'active' | 'invalid' | 'expiring'

export type ArtifactSource = 'github_release' | 'cli_upload'

export type EntitlementType = 'perpetual' | 'balance' | 'recurring'

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

/** Tenant-level settings stored in tenants.settings_json. */
export interface TenantSettings {
  staleReviewDays?: Partial<Record<Store, number>>
}

export const DEFAULT_STALE_REVIEW_DAYS: Record<Store, number> = {
  chrome: 3,
  firefox: 3,
  edge: 10,
  safari: 3,
}
