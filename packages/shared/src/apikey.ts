import { customAlphabet } from 'nanoid'
import { sha256Hex } from './crypto'

export const API_KEY_PREFIX = 'sk_live_'

const keyBody = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 40)

export interface GeneratedApiKey {
  /** Full plaintext key — shown to the tenant exactly once, never stored. */
  key: string
  /** Last four characters, stored for display ("sk_live_…abcd"). */
  last4: string
}

export function generateApiKey(): GeneratedApiKey {
  const key = `${API_KEY_PREFIX}${keyBody()}`
  return { key, last4: key.slice(-4) }
}

/** Only this hash is persisted; lookups are done by exact hash match. */
export function hashApiKey(key: string): Promise<string> {
  return sha256Hex(key)
}

export function isApiKeyFormat(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX) && value.length === API_KEY_PREFIX.length + 40
}

export function maskApiKey(last4: string): string {
  return `${API_KEY_PREFIX}…${last4}`
}
