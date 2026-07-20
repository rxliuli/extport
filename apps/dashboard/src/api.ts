export interface Me {
  authType: 'session' | 'api_key'
  tenant: { id: string; name: string; plan: string }
  user: { id: string; email: string; displayName: string | null } | null
}

export interface Extension {
  id: string
  name: string
  slug: string
  publishingEnabled: boolean
  licensingEnabled: boolean
}

export type Store = 'chrome' | 'firefox' | 'edge' | 'apple'
export type DeploymentStatus = 'synced' | 'submitting' | 'in_review' | 'rejected' | 'blocked' | 'error'

export interface MatrixTarget {
  targetId: string
  store: Store
  enabled: boolean
  credentialLabel: string
  credentialStatus: 'active' | 'invalid' | 'expiring'
  status: DeploymentStatus
  liveVersion: string | null
  inReviewVersion: string | null
  statusDetail: string | null
  /** ISO date string (Date -> JSON) */
  submittedAt: string | null
  /** ISO date string (Date -> JSON) */
  lastReconciledAt: string | null
}

export interface MatrixExtension {
  id: string
  name: string
  slug: string
  publishingEnabled: boolean
  targets: MatrixTarget[]
}

export interface PublishTarget {
  id: string
  store: Store
  storeItemId: string
  enabled: boolean
  credentialId: string
  credentialLabel: string
  credentialStatus: 'active' | 'invalid' | 'expiring'
}

export interface PublishEvent {
  id: string
  store: Store
  type: 'submitted' | 'approved' | 'rejected' | 'withdrawn' | 'error' | 'stale_review'
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

export interface TenantSettings {
  autoWithdraw: boolean
  staleReviewDays: Record<Store, number>
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
