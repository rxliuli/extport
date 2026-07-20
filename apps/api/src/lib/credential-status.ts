export const EXPIRING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export type CredentialStatus = 'active' | 'invalid' | 'expiring'

export function statusFor(ok: boolean, expiresAt: Date | null): CredentialStatus {
  if (!ok) return 'invalid'
  if (expiresAt && expiresAt.getTime() - Date.now() < EXPIRING_WINDOW_MS) return 'expiring'
  return 'active'
}
