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

export interface ApiKeyRow {
  id: string
  name: string
  masked: string
  createdAt: number
  lastUsedAt: number | null
}

export interface CredentialRow {
  id: string
  store: 'chrome' | 'firefox' | 'edge' | 'apple'
  label: string
  hint: string
  status: 'active' | 'invalid' | 'expiring'
  expiresAt: number | null
  lastVerifiedAt: number | null
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
