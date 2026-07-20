import { describe, expect, it } from 'vitest'
import { credentialHint, CredentialValidationError, parseCredentials } from '../src/validate'

describe('parseCredentials', () => {
  it('accepts complete payloads and strips extras', () => {
    const parsed = parseCredentials('chrome', {
      publisherId: ' pub-1 ',
      clientEmail: 'sa@project.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      injected: 'evil',
    })
    expect(parsed).toEqual({
      publisherId: 'pub-1',
      clientEmail: 'sa@project.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    })
  })

  it('lists every missing field', () => {
    expect(() => parseCredentials('safari', { keyId: 'k' })).toThrow(
      /missing or empty credential fields: issuerId, privateKeyP8/,
    )
    expect(() => parseCredentials('chrome', { publisherId: 'p' })).toThrow(
      /missing or empty credential fields: clientEmail, privateKey/,
    )
    expect(() => parseCredentials('firefox', null)).toThrow(CredentialValidationError)
  })

  it('rejects empty strings', () => {
    expect(() => parseCredentials('edge', { clientId: 'x', apiKey: '   ' })).toThrow(/apiKey/)
  })
})

describe('credentialHint', () => {
  it('returns the last4 of the identifying field per store', () => {
    expect(
      credentialHint('chrome', { publisherId: 'pub-0000001', clientEmail: 'a@b.iam.gserviceaccount.com', privateKey: 'x' }),
    ).toBe('0001')
    expect(credentialHint('firefox', { jwtIssuer: 'i', jwtSecret: 'secret99' })).toBe('et99')
    expect(credentialHint('edge', { clientId: 'c', apiKey: 'edgekey123' })).toBe('y123')
    expect(credentialHint('safari', { keyId: 'AB12CD34', issuerId: 'i', privateKeyP8: 'p' })).toBe('CD34')
  })
})
