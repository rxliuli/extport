import { describe, expect, it } from 'vitest'
import { credentialHint, CredentialValidationError, parseCredentials } from '../src/validate'

describe('parseCredentials', () => {
  it('accepts complete payloads and strips extras', () => {
    const parsed = parseCredentials('chrome', {
      clientId: ' cid ',
      clientSecret: 'sec',
      refreshToken: 'rt',
      injected: 'evil',
    })
    expect(parsed).toEqual({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' })
  })

  it('lists every missing field', () => {
    expect(() => parseCredentials('apple', { keyId: 'k' })).toThrow(
      /missing or empty credential fields: issuerId, privateKeyP8/,
    )
    expect(() => parseCredentials('firefox', null)).toThrow(CredentialValidationError)
  })

  it('rejects empty strings', () => {
    expect(() => parseCredentials('edge', { clientId: 'x', apiKey: '   ' })).toThrow(/apiKey/)
  })
})

describe('credentialHint', () => {
  it('returns the last4 of the identifying field per store', () => {
    expect(credentialHint('chrome', { clientId: 'a', clientSecret: 'b', refreshToken: '1//abcdef' })).toBe('cdef')
    expect(credentialHint('firefox', { jwtIssuer: 'i', jwtSecret: 'secret99' })).toBe('et99')
    expect(credentialHint('edge', { clientId: 'c', apiKey: 'edgekey123' })).toBe('y123')
    expect(credentialHint('apple', { keyId: 'AB12CD34', issuerId: 'i', privateKeyP8: 'p' })).toBe('CD34')
  })
})
