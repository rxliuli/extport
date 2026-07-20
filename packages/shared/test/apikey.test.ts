import { describe, expect, it } from 'vitest'
import { generateApiKey, hashApiKey, isApiKeyFormat, maskApiKey } from '../src/apikey'

describe('api keys', () => {
  it('generates sk_live_ keys with matching last4', () => {
    const { key, last4 } = generateApiKey()
    expect(key).toMatch(/^sk_live_[0-9a-zA-Z]{40}$/)
    expect(key.endsWith(last4)).toBe(true)
    expect(isApiKeyFormat(key)).toBe(true)
  })

  it('rejects non-key formats', () => {
    expect(isApiKeyFormat('sk_live_short')).toBe(false)
    expect(isApiKeyFormat('pk_live_' + 'a'.repeat(40))).toBe(false)
  })

  it('hashes deterministically to sha256 hex', async () => {
    const { key } = generateApiKey()
    const h1 = await hashApiKey(key)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(await hashApiKey(key)).toBe(h1)
    expect(await hashApiKey(generateApiKey().key)).not.toBe(h1)
  })

  it('masks with last4 only', () => {
    expect(maskApiKey('abcd')).toBe('sk_live_…abcd')
  })
})
