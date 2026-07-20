export const STORES = ['chrome', 'firefox', 'edge', 'apple'] as const
export type Store = (typeof STORES)[number]

export type DeploymentStatus =
  | 'synced'
  | 'submitting'
  | 'in_review'
  | 'rejected'
  | 'blocked'
  | 'error'

export type PublishEventType =
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'blocked'
  | 'error'
  | 'stale_review'

export type CredentialHealth = 'active' | 'invalid' | 'expiring'

export type ArtifactSource = 'github_release' | 'cli_upload'

export type EntitlementType = 'perpetual' | 'balance' | 'recurring'

export type Plan = 'free' | 'starter' | 'pro'

export interface PlanLimits {
  /** null = unlimited */
  maxExtensions: number | null
  /** null = all stores */
  maxStoresPerExtension: number | null
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { maxExtensions: 1, maxStoresPerExtension: 2 },
  starter: { maxExtensions: 5, maxStoresPerExtension: null },
  pro: { maxExtensions: null, maxStoresPerExtension: null },
}

/** Tenant-level settings stored in tenants.settings_json. */
export interface TenantSettings {
  staleReviewDays?: Partial<Record<Store, number>>
}

export const DEFAULT_STALE_REVIEW_DAYS: Record<Store, number> = {
  chrome: 3,
  firefox: 3,
  edge: 10,
  apple: 3,
}
