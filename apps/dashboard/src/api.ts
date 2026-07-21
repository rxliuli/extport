export interface Me {
  authType: 'session' | 'api_key'
  tenant: { id: string; name: string; plan: string }
  user: { id: string; email: string; displayName: string | null } | null
}

export interface Extension {
  id: string
  name: string
  slug: string
  licensingEnabled: boolean
}

export type Store = 'chrome' | 'firefox' | 'edge' | 'safari'
/** The current, derived status for a (extension, store) target — see apps/api's reconcile/status.ts. */
export type DeploymentStatus = 'synced' | 'queued' | 'in_review' | 'blocked' | 'rejected' | 'error'

export type SafariPlatform = 'macos' | 'ios'

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
}

export interface MatrixTarget {
  targetId: string
  store: Store
  enabled: boolean
  credentialLabel: string
  credentialStatus: 'active' | 'invalid' | 'expiring'
  lifecycles: TargetLifecycle[]
  /** ISO date string (Date -> JSON) */
  lastReconciledAt: string | null
}

export interface MatrixExtension {
  id: string
  name: string
  slug: string
  targets: MatrixTarget[]
}

export interface PublishTarget {
  id: string
  store: Store
  storeItemId: string
  /** Edge only — Partner Center's Submission API needs storeItemId to be the Product ID; this is the separate crx id its public status fallback needs. */
  crxId: string | null
  enabled: boolean
  credentialId: string
  credentialLabel: string
  credentialStatus: 'active' | 'invalid' | 'expiring'
  lifecycles: TargetLifecycle[]
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
  type: 'error' | 'recovered' | 'stale_review'
  payloadJson: string
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
