import type { Store } from '@extport/shared'

export interface StoreState {
  liveVersion: string | null
  inReviewVersion: string | null
  reviewStatus?: string
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
 * One implementation per store (chrome | firefox | edge | apple).
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
  /** Only stores that can cancel an in-review submission implement this (Chrome, Apple). */
  withdraw?(credentials: TCredentials, storeItemId: string): Promise<void>
}

// Credential payload shapes stored (encrypted) in store_credentials.encrypted_payload.

export interface ChromeCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export interface FirefoxCredentials {
  jwtIssuer: string
  jwtSecret: string
}

export interface EdgeCredentials {
  clientId: string
  apiKey: string
}

export interface AppleCredentials {
  keyId: string
  issuerId: string
  privateKeyP8: string
}
