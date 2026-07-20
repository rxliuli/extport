export const EXPIRING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export type CredentialStatus = 'active' | 'invalid' | 'expiring'

export function statusFor(ok: boolean, expiresAt: string | null): CredentialStatus {
  if (!ok) return 'invalid'
  if (expiresAt && new Date(expiresAt).getTime() - Date.now() < EXPIRING_WINDOW_MS) return 'expiring'
  return 'active'
}
