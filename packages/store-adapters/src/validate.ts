import type { Store } from '@extport/shared'
import type {
  ChromeCredentials,
  EdgeCredentials,
  FirefoxCredentials,
  SafariCredentials,
} from './types'

export interface CredentialsByStore {
  chrome: ChromeCredentials
  firefox: FirefoxCredentials
  edge: EdgeCredentials
  safari: SafariCredentials
}

export const CREDENTIAL_FIELDS: { [S in Store]: (keyof CredentialsByStore[S])[] } = {
  chrome: ['publisherId', 'clientEmail', 'privateKey'],
  firefox: ['jwtIssuer', 'jwtSecret'],
  edge: ['clientId', 'apiKey'],
  safari: ['keyId', 'issuerId', 'privateKeyP8'],
}

export class CredentialValidationError extends Error {}

/** Strict-parse an untrusted credential payload: required non-empty strings, extras dropped. */
export function parseCredentials<S extends Store>(store: S, input: unknown): CredentialsByStore[S] {
  if (typeof input !== 'object' || input === null) {
    throw new CredentialValidationError('credentials must be an object')
  }
  const source = input as Record<string, unknown>
  const result: Record<string, string> = {}
  const missing: string[] = []
  for (const field of CREDENTIAL_FIELDS[store] as string[]) {
    const value = source[field]
    if (typeof value !== 'string' || value.trim().length === 0) {
      missing.push(field)
    } else {
      result[field] = value.trim()
    }
  }
  if (missing.length > 0) {
    throw new CredentialValidationError(`missing or empty credential fields: ${missing.join(', ')}`)
  }
  // Runtime-validated boundary: every field in CREDENTIAL_FIELDS[store] is present.
  return result as unknown as CredentialsByStore[S]
}

/** The only plaintext-derived value that may be stored: last 4 chars of the identifying field. */
export function credentialHint<S extends Store>(store: S, credentials: CredentialsByStore[S]): string {
  const field: Record<Store, string> = {
    // publisherId (not the private key) — short and human-recognizable, like the other stores' hints.
    chrome: (credentials as ChromeCredentials).publisherId ?? '',
    firefox: (credentials as FirefoxCredentials).jwtSecret ?? '',
    edge: (credentials as EdgeCredentials).apiKey ?? '',
    safari: (credentials as SafariCredentials).keyId ?? '',
  }
  return field[store].slice(-4)
}
