import type { Store } from '@extport/shared'

/**
 * `known: false` = the store's API cannot report this field at all — the
 * reconciler must preserve whatever it already knew instead of overwriting
 * with a false "nothing here." `known: true` with `version` unset = the
 * store confirms there is no live/in-review version (an authoritative
 * "nothing here"). `known: true` with `version` set = the actual version.
 * Edge is always `known: false` for both (confirmed API gap); Chrome/
 * Firefox/Safari are always `known: true`.
 */
export type VersionKnowledge = { known: false } | { known: true; version?: string }

export interface StoreState {
  live: VersionKnowledge
  inReview: VersionKnowledge
  reviewStatus?: 'pending' | 'rejected'
  /** Only Firefox/Safari can say anything useful here; Chrome/Edge never expose review text via API. */
  rejectionReason?: string
}

export type CredentialCheck =
  | { ok: true; expiresAt?: Date }
  | { ok: false; reason: string }

export interface SubmissionResult {
  submitted: boolean
  /**
   * True = "couldn't submit yet, but nothing is wrong — leave the version
   * queued and retry next tick." Distinct from a plain failure (which the
   * reconciler records as a target error): Safari waits for a binary the
   * tenant's macOS pipeline uploads out-of-band, Edge waits out its package
   * validation poll window. Neither deserves an error event, let alone an
   * error email per tick.
   */
  waiting?: boolean
  detail?: string
}

/**
 * `storeItemId` is whatever identifies this listing to the store's real
 * submission/management API — the thing that actually mutates state.
 * `crxId` exists only for Edge: Partner Center's Submission API requires an
 * internal GUID "Product ID" (storeItemId) that has no query endpoint at
 * all, while the public store-detail page (used as a best-effort getState
 * fallback) is keyed by the store-facing extension id instead — two
 * different Microsoft ID namespaces for the same listing. Every other store
 * uses one id for everything and ignores crxId.
 */
export interface StoreTarget {
  storeItemId: string
  crxId?: string
}

/**
 * One implementation per store (chrome | firefox | edge | safari).
 * Credentials arrive already decrypted (tenant DEK) and must never be logged.
 *
 * `platforms`: stores where one listing spans several independent review
 * timelines declare them here (Safari: macos + ios) and the reconciler runs
 * one full lifecycle per platform, passing it back into every call below.
 * Undefined = one unnamed lifecycle, platform arguments are never passed.
 *
 * `version` on submit: chrome/firefox/edge upload the artifact zip, which
 * carries its own version. Safari's binary never travels through extport —
 * the tenant's macOS pipeline uploads it to App Store Connect directly
 * (docs/safari-pipeline.md), so submit() needs to be told which queued
 * version it is orchestrating.
 */
export interface StoreAdapter<TCredentials = unknown> {
  readonly store: Store
  readonly platforms?: readonly string[]
  verifyCredentials(credentials: TCredentials): Promise<CredentialCheck>
  getState(credentials: TCredentials, target: StoreTarget, platform?: string): Promise<StoreState>
  submit(
    credentials: TCredentials,
    target: StoreTarget,
    artifact: ArrayBuffer,
    version: string,
    platform?: string,
  ): Promise<SubmissionResult>
  /** Only stores that can cancel an in-review submission implement this (Chrome, Safari). */
  withdraw?(credentials: TCredentials, target: StoreTarget, platform?: string): Promise<void>
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
