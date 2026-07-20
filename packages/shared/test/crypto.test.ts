import { describe, expect, it } from 'vitest'
import {
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
  fromBase64,
  generateDek,
  randomBytes,
  sha256Hex,
  toBase64,
  unwrapDek,
  wrapDek,
} from '../src/crypto'

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = randomBytes(1000)
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  })

  it('handles empty input', () => {
    expect(fromBase64(toBase64(new Uint8Array(0)))).toEqual(new Uint8Array(0))
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips plaintext', async () => {
    const key = generateDek()
    const plaintext = new TextEncoder().encode('hello extport')
    const payload = await encrypt(key, plaintext)
    expect(await decrypt(key, payload)).toEqual(plaintext)
  })

  it('produces the v1.<iv>.<ct> wire format', async () => {
    const payload = await encrypt(generateDek(), new Uint8Array([1, 2, 3]))
    const parts = payload.split('.')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe('v1')
    expect(fromBase64(parts[1]!)).toHaveLength(12)
  })

  it('uses a fresh IV per call (same input, different ciphertext)', async () => {
    const key = generateDek()
    const plaintext = new TextEncoder().encode('same input')
    expect(await encrypt(key, plaintext)).not.toBe(await encrypt(key, plaintext))
  })

  it('rejects the wrong key', async () => {
    const payload = await encrypt(generateDek(), new TextEncoder().encode('secret'))
    await expect(decrypt(generateDek(), payload)).rejects.toThrow(/wrong key or corrupted/)
  })

  it('rejects tampered ciphertext', async () => {
    const key = generateDek()
    const payload = await encrypt(key, new TextEncoder().encode('secret'))
    const parts = payload.split('.')
    const ct = fromBase64(parts[2]!)
    ct[0]! ^= 0xff
    const tampered = `${parts[0]}.${parts[1]}.${toBase64(ct)}`
    await expect(decrypt(key, tampered)).rejects.toThrow(/wrong key or corrupted/)
  })

  it('rejects malformed payloads', async () => {
    const key = generateDek()
    await expect(decrypt(key, 'not-a-payload')).rejects.toThrow(/malformed/)
    await expect(decrypt(key, 'v2.a.b')).rejects.toThrow(/malformed/)
  })

  it('rejects keys of the wrong length', async () => {
    await expect(encrypt(randomBytes(16), new Uint8Array([1]))).rejects.toThrow(/32 bytes/)
  })
})

describe('encryptJson / decryptJson', () => {
  it('round-trips structured credentials', async () => {
    const key = generateDek()
    const credentials = {
      store: 'chrome',
      clientId: 'abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret',
      refreshToken: '1//refresh',
      nested: { unicode: '测试 🚀' },
    }
    const payload = await encryptJson(key, credentials)
    expect(payload).not.toContain('GOCSPX')
    expect(await decryptJson(key, payload)).toEqual(credentials)
  })
})

describe('envelope encryption (KEK → DEK → payload)', () => {
  it('supports the full wrap → unwrap → decrypt cycle', async () => {
    const kek = generateDek()
    const dek = generateDek()
    const wrapped = await wrapDek(kek, dek)

    const secret = { apiKey: 'edge-api-key', clientId: 'edge-client' }
    const payload = await encryptJson(dek, secret)

    const recovered = await unwrapDek(kek, wrapped)
    expect(recovered).toEqual(dek)
    expect(await decryptJson(recovered, payload)).toEqual(secret)
  })

  it('supports KEK rotation by re-wrapping the same DEK', async () => {
    const kekV1 = generateDek()
    const kekV2 = generateDek()
    const dek = generateDek()

    const wrappedV1 = await wrapDek(kekV1, dek)
    const rewrapped = await wrapDek(kekV2, await unwrapDek(kekV1, wrappedV1))

    expect(await unwrapDek(kekV2, rewrapped)).toEqual(dek)
    await expect(unwrapDek(kekV2, wrappedV1)).rejects.toThrow()
  })

  it('refuses to unwrap something that is not a 32-byte key', async () => {
    const kek = generateDek()
    const notADek = await encrypt(kek, randomBytes(16))
    await expect(unwrapDek(kek, notADek)).rejects.toThrow(/32 bytes/)
  })
})

describe('sha256Hex', () => {
  it('matches a known vector', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
