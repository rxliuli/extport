import type { Store } from '@extport/shared'

export interface StoreState {
  /**
   * `null` = the store confirms there is no live/in-review version (an
   * authoritative "nothing here"). `undefined` (the field omitted) = the
   * store's API cannot report this field at all — the reconciler must
   * preserve whatever it already knew instead of overwriting with a false
   * "nothing here." Edge always omits both fields (confirmed API gap);
   * Chrome/Firefox/Safari return a real string or an authoritative null.
   */
  liveVersion?: string | null
  inReviewVersion?: string | null
  reviewStatus?: 'pending' | 'rejected'
  /** Only Firefox/Safari can say anything useful here; Chrome/Edge never expose review text via API. */
  rejectionReason?: string
}

export type CredentialCheck =
  | { ok: true; expiresAt?: Date }
  | { ok: false; reason: string }

export interface SubmissionResult {
  submitted: boolean
  detail?: string
}

/**
 * One implementation per store (chrome | firefox | edge | safari).
 * Credentials arrive already decrypted (tenant DEK) and must never be logged.
 */
export interface StoreAdapter<TCredentials = unknown> {
  readonly store: Store
  verifyCredentials(credentials: TCredentials): Promise<CredentialCheck>
  getState(credentials: TCredentials, storeItemId: string): Promise<StoreState>
  submit(
    credentials: TCredentials,
    storeItemId: string,
    artifact: ArrayBuffer,
  ): Promise<SubmissionResult>
  /** Only stores that can cancel an in-review submission implement this (Chrome, Safari). */
  withdraw?(credentials: TCredentials, storeItemId: string): Promise<void>
}

// Credential payload shapes stored (encrypted) in store_credentials.encrypted_payload.

/**
 * Chrome Web Store Publish API v2 uses a GCP service account (no OAuth
 * consent screen, no refresh-token expiry) — the tenant creates a service
 * account, downloads its JSON key, and adds the service account email as a
 * collaborator on their Chrome Web Store developer account.
 */
export interface ChromeCredentials {
  /** The Chrome Web Store developer/publisher id (from Developer Dashboard settings). */
  publisherId: string
  /** `client_email` from the service account's JSON key. */
  clientEmail: string
  /** `private_key` (PEM, PKCS8) from the service account's JSON key. */
  privateKey: string
}

export interface FirefoxCredentials {
  jwtIssuer: string
  jwtSecret: string
}

export interface EdgeCredentials {
  clientId: string
  apiKey: string
}

export interface SafariCredentials {
  keyId: string
  issuerId: string
  privateKeyP8: string
}
