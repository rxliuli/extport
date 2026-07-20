import { describe, expect, it } from 'vitest'
import { compareVersions, isValidExtensionVersion, maxVersion } from '../src/version'

describe('isValidExtensionVersion', () => {
  it('accepts 1–4 numeric parts', () => {
    for (const v of ['1', '1.2', '1.2.3', '1.2.3.4', '0.1.0', '65535.0']) {
      expect(isValidExtensionVersion(v), v).toBe(true)
    }
  })

  it('rejects invalid shapes', () => {
    for (const v of ['', 'v1.2.3', '1.2.3-beta', '1.2.3.4.5', '1..2', '01.2', '65536', '1.2.', 'a.b']) {
      expect(isValidExtensionVersion(v), v).toBe(false)
    }
  })
})

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
  })

  it('treats missing parts as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.0.1', '1.2')).toBe(1)
  })
})

describe('maxVersion', () => {
  it('finds the latest', () => {
    expect(maxVersion(['1.2.3', '1.10.0', '1.9.9'])).toBe('1.10.0')
    expect(maxVersion([])).toBeNull()
  })
})
