/** Minimal JWT signing (HS256 for AMO, ES256 for App Store Connect) on Web Crypto. */

const encoder = new TextEncoder()

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function signingInput(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
}

export async function signJwtHS256(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const input = signingInput({ alg: 'HS256', typ: 'JWT' }, payload)
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(input))
  return `${input}.${b64url(new Uint8Array(signature))}`
}

export function pemToPkcs8(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function signJwtES256(
  payload: Record<string, unknown>,
  options: { keyId: string; privateKeyP8: string },
): Promise<string> {
  const input = signingInput({ alg: 'ES256', kid: options.keyId, typ: 'JWT' }, payload)
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(options.privateKeyP8) as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  // Web Crypto emits raw r||s (64 bytes) — exactly the JOSE ES256 format.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(input),
  )
  return `${input}.${b64url(new Uint8Array(signature))}`
}
