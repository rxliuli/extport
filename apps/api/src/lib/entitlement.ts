import type { EntitlementType, SubscriptionStatus } from '@extport/shared'
import type { License, Plan, Subscription } from '../db'

export type EntitleableSubscription = Pick<Subscription, 'status' | 'currentPeriodEnd'>

/**
 * Single source of truth for whether a subscription currently grants access:
 * active when `status` is `'active' | 'trialing' | 'past_due'` OR
 * `status === 'canceled'` with `currentPeriodEnd` still in the future.
 */
export function isSubscriptionEntitled(sub: EntitleableSubscription, nowMs = Date.now()): boolean {
  if (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due') {
    return true
  }
  if (sub.status === 'canceled' && sub.currentPeriodEnd) {
    const endMs = new Date(sub.currentPeriodEnd).getTime()
    return Number.isFinite(endMs) && endMs > nowMs
  }
  return false
}

export interface SubscriptionWithPlan {
  subscription: Subscription
  plan: Plan
}

function subscriptionStatusRank(status: SubscriptionStatus): number {
  switch (status) {
    case 'active':
      return 4
    case 'trialing':
      return 3
    case 'past_due':
      return 2
    case 'canceled':
      return 1
    default:
      return 0
  }
}

function subscriptionPeriodEndSortValue(sub: Subscription): number {
  if (!sub.currentPeriodEnd) return 0
  const ms = new Date(sub.currentPeriodEnd).getTime()
  return Number.isFinite(ms) ? ms : 0
}

/**
 * When multiple subscriptions match a user/email lookup (for example, an old
 * expired subscription alongside a newer active one), prefer an entitled
 * subscription over an inactive one, then higher status rank (`active > trialing
 * > past_due > canceled`), furthest `currentPeriodEnd`, newest `createdAt`.
 */
export function pickBestSubscription(
  candidates: SubscriptionWithPlan[],
  nowMs = Date.now(),
): SubscriptionWithPlan | null {
  if (candidates.length === 0) return null
  const sorted = [...candidates].sort((a, b) => {
    const aActive = isSubscriptionEntitled(a.subscription, nowMs)
    const bActive = isSubscriptionEntitled(b.subscription, nowMs)
    if (aActive !== bActive) return aActive ? -1 : 1
    if (aActive && bActive) {
      const rankDiff = subscriptionStatusRank(b.subscription.status) - subscriptionStatusRank(a.subscription.status)
      if (rankDiff !== 0) return rankDiff
      const endDiff = subscriptionPeriodEndSortValue(b.subscription) - subscriptionPeriodEndSortValue(a.subscription)
      if (endDiff !== 0) return endDiff
    }
    if (a.subscription.createdAt !== b.subscription.createdAt) {
      return a.subscription.createdAt > b.subscription.createdAt ? -1 : 1
    }
    return b.subscription.id.localeCompare(a.subscription.id)
  })
  return sorted[0] ?? null
}

export interface SubscriptionEntitlementResult {
  active: boolean
  tier: string
  subscriptionId: string | null
  status: SubscriptionStatus | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
}

export function formatSubscriptionEntitlement(
  match: SubscriptionWithPlan | null,
  nowMs = Date.now(),
): SubscriptionEntitlementResult {
  if (!match) {
    return {
      active: false,
      tier: 'free',
      subscriptionId: null,
      status: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    }
  }
  const active = isSubscriptionEntitled(match.subscription, nowMs)
  return {
    active,
    tier: active ? match.plan.tier : 'free',
    subscriptionId: match.subscription.id,
    status: match.subscription.status,
    currentPeriodStart: match.subscription.currentPeriodStart ?? null,
    currentPeriodEnd: match.subscription.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: match.subscription.cancelAtPeriodEnd,
  }
}

export type EntitleableLicense = Pick<License, 'status' | 'entitlementType' | 'subscriptionStatus' | 'currentPeriodEnd'>

/**
 * Single source of truth for whether a license currently grants access.
 * - Perpetual: active when `license.status === 'active'`.
 * - Recurring: active when `license.status === 'active'` AND either
 *   `subscriptionStatus` is `'active' | 'trialing' | 'past_due'` OR
 *   `subscriptionStatus === 'canceled'` with `currentPeriodEnd` still in the future.
 */
export function isLicenseEntitled(license: EntitleableLicense, nowMs = Date.now()): boolean {
  if (license.status !== 'active') return false
  if (license.entitlementType === 'perpetual') return true
  if (license.entitlementType === 'recurring') {
    if (
      license.subscriptionStatus === 'active' ||
      license.subscriptionStatus === 'trialing' ||
      license.subscriptionStatus === 'past_due'
    ) {
      return true
    }
    if (license.subscriptionStatus === 'canceled' && license.currentPeriodEnd) {
      const endMs = new Date(license.currentPeriodEnd).getTime()
      return Number.isFinite(endMs) && endMs > nowMs
    }
    return false
  }
  return false
}

export interface LicenseWithPlan {
  license: License
  plan: Plan
}

function activeRank(license: License): number {
  if (license.entitlementType === 'perpetual') return 4
  switch (license.subscriptionStatus) {
    case 'active':
      return 4
    case 'trialing':
      return 3
    case 'past_due':
      return 2
    case 'canceled':
      return 1
    default:
      return 0
  }
}

function periodEndSortValue(license: License): number {
  if (license.entitlementType === 'perpetual') return Number.MAX_SAFE_INTEGER
  if (!license.currentPeriodEnd) return 0
  const ms = new Date(license.currentPeriodEnd).getTime()
  return Number.isFinite(ms) ? ms : 0
}

/**
 * When multiple licenses match a user/email/key lookup (for example, an old
 * expired subscription alongside a newer active one), prefer an entitled
 * license over an inactive one, then higher status rank / furthest period end /
 * newest creation date.
 */
export function pickBestLicense(candidates: LicenseWithPlan[], nowMs = Date.now()): LicenseWithPlan | null {
  if (candidates.length === 0) return null
  const sorted = [...candidates].sort((a, b) => {
    const aActive = isLicenseEntitled(a.license, nowMs)
    const bActive = isLicenseEntitled(b.license, nowMs)
    if (aActive !== bActive) return aActive ? -1 : 1
    if (aActive && bActive) {
      const rankDiff = activeRank(b.license) - activeRank(a.license)
      if (rankDiff !== 0) return rankDiff
      const endDiff = periodEndSortValue(b.license) - periodEndSortValue(a.license)
      if (endDiff !== 0) return endDiff
    }
    if (a.license.createdAt !== b.license.createdAt) {
      return a.license.createdAt > b.license.createdAt ? -1 : 1
    }
    return b.license.id.localeCompare(a.license.id)
  })
  return sorted[0] ?? null
}

export interface EntitlementResult {
  active: boolean
  tier: string
  entitlementType: EntitlementType | null
  licenseId: string | null
  subscriptionStatus: SubscriptionStatus | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  billingPortalUrl: string | null
}

export function formatEntitlementResponse(
  match: LicenseWithPlan | null,
  billingPortalUrl: string | null,
  nowMs = Date.now(),
): EntitlementResult {
  if (!match) {
    return {
      active: false,
      tier: 'free',
      entitlementType: null,
      licenseId: null,
      subscriptionStatus: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      billingPortalUrl,
    }
  }
  const active = isLicenseEntitled(match.license, nowMs)
  return {
    active,
    tier: active ? match.plan.tier : 'free',
    entitlementType: match.license.entitlementType,
    licenseId: match.license.id,
    subscriptionStatus: match.license.subscriptionStatus ?? null,
    currentPeriodStart: match.license.currentPeriodStart ?? null,
    currentPeriodEnd: match.license.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: match.license.cancelAtPeriodEnd,
    billingPortalUrl,
  }
}
