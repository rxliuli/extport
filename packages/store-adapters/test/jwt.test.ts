import { describe, expect, it } from 'vitest'
import { pemToPkcs8, signJwtES256, signJwtHS256, signJwtRS256 } from '../src/jwt'

const encoder = new TextEncoder()

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)))
}

describe('signJwtHS256', () => {
  it('produces a verifiable token with the expected header and payload', async () => {
    const token = await signJwtHS256({ iss: 'user:123', exp: 1234 }, 'top-secret')
    const [header, payload, signature] = token.split('.') as [string, string, string]

    expect(decodeSegment(header)).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(decodeSegment(payload)).toEqual({ iss: 'user:123', exp: 1234 })

    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode('top-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlToBytes(signature) as BufferSource,
      encoder.encode(`${header}.${payload}`),
    )
    expect(valid).toBe(true)
  })
})

describe('signJwtES256', () => {
  it('signs with a PEM .p8 key, verifiable with the public key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    let binary = ''
    for (const b of pkcs8) binary += String.fromCharCode(b)
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`

    const token = await signJwtES256(
      { iss: 'issuer-id', aud: 'appstoreconnect-v1' },
      { keyId: 'ABC123', privateKeyP8: pem },
    )
    const [header, payload, signature] = token.split('.') as [string, string, string]
    expect(decodeSegment(header)).toEqual({ alg: 'ES256', kid: 'ABC123', typ: 'JWT' })

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      b64urlToBytes(signature) as BufferSource,
      encoder.encode(`${header}.${payload}`),
    )
    expect(valid).toBe(true)
    expect(decodeSegment(payload).aud).toBe('appstoreconnect-v1')
  })

  it('round-trips PEM decoding ignoring whitespace', () => {
    const bytes = pemToPkcs8('-----BEGIN PRIVATE KEY-----\nAAEC\n  Aw==\n-----END PRIVATE KEY-----')
    expect([...bytes]).toEqual([0, 1, 2, 3])
  })
})

describe('signJwtRS256', () => {
  it('signs a GCP service-account-style assertion, verifiable with the public key', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ['sign', 'verify'],
    )
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    let binary = ''
    for (const b of pkcs8) binary += String.fromCharCode(b)
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`

    const token = await signJwtRS256(
      { iss: 'sa@project.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/chromewebstore' },
      { privateKeyPkcs8Pem: pem },
    )
    const [header, payload, signature] = token.split('.') as [string, string, string]
    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' })

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      pair.publicKey,
      b64urlToBytes(signature) as BufferSource,
      encoder.encode(`${header}.${payload}`),
    )
    expect(valid).toBe(true)
    expect(decodeSegment(payload).iss).toBe('sa@project.iam.gserviceaccount.com')
  })
})
