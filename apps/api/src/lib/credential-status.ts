// Edge is the only store whose credential expires at all (~72 days), so this
// is sized relative to that: a week is plenty of lead time for a rotation
// that's just generating a new key and pasting it in, no external review —
// 30 days would flag it as "expiring" for nearly half its life.
export const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export type CredentialStatus = 'active' | 'invalid' | 'expiring'

export function statusFor(ok: boolean, expiresAt: string | null): CredentialStatus {
  if (!ok) return 'invalid'
  if (expiresAt && new Date(expiresAt).getTime() - Date.now() < EXPIRING_WINDOW_MS) return 'expiring'
  return 'active'
}
