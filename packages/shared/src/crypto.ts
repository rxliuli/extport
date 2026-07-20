/**
 * Envelope encryption built on Web Crypto (AES-256-GCM), usable in both
 * Cloudflare Workers and Node >= 18.
 *
 * Model:
 *   KEK (master key, Workers secret, versioned) --wraps--> per-tenant DEK
 *   DEK --encrypts--> credential/secret payloads stored in D1
 *
 * Wire format for every ciphertext: `v1.<base64 iv>.<base64 ciphertext+tag>`
 */

const PAYLOAD_VERSION = 'v1'
const KEY_LENGTH = 32
const IV_LENGTH = 12

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function generateDek(): Uint8Array {
  return randomBytes(KEY_LENGTH)
}

function assertKeyLength(keyBytes: Uint8Array): void {
  if (keyBytes.length !== KEY_LENGTH) {
    throw new Error(`encryption key must be ${KEY_LENGTH} bytes, got ${keyBytes.length}`)
  }
}

function importAesKey(keyBytes: Uint8Array, usages: ('encrypt' | 'decrypt')[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, usages)
}

export async function encrypt(keyBytes: Uint8Array, plaintext: Uint8Array): Promise<string> {
  assertKeyLength(keyBytes)
  const iv = randomBytes(IV_LENGTH)
  const key = await importAesKey(keyBytes, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource),
  )
  return `${PAYLOAD_VERSION}.${toBase64(iv)}.${toBase64(ciphertext)}`
}

export async function decrypt(keyBytes: Uint8Array, payload: string): Promise<Uint8Array> {
  assertKeyLength(keyBytes)
  const parts = payload.split('.')
  if (parts.length !== 3 || parts[0] !== PAYLOAD_VERSION) {
    throw new Error('malformed encrypted payload')
  }
  const iv = fromBase64(parts[1]!)
  const ciphertext = fromBase64(parts[2]!)
  const key = await importAesKey(keyBytes, ['decrypt'])
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    )
    return new Uint8Array(plaintext)
  } catch {
    throw new Error('decryption failed: wrong key or corrupted payload')
  }
}

export async function encryptJson(keyBytes: Uint8Array, value: unknown): Promise<string> {
  return encrypt(keyBytes, new TextEncoder().encode(JSON.stringify(value)))
}

export async function decryptJson<T>(keyBytes: Uint8Array, payload: string): Promise<T> {
  const plaintext = await decrypt(keyBytes, payload)
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}

/** Encrypt a tenant DEK under the master KEK. */
export function wrapDek(kekBytes: Uint8Array, dekBytes: Uint8Array): Promise<string> {
  assertKeyLength(dekBytes)
  return encrypt(kekBytes, dekBytes)
}

/** Recover a tenant DEK using the master KEK. */
export async function unwrapDek(kekBytes: Uint8Array, wrapped: string): Promise<Uint8Array> {
  const dek = await decrypt(kekBytes, wrapped)
  assertKeyLength(dek)
  return dek
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
