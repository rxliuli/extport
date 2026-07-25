import { describe, expect, it } from 'vitest'
import { normaliseBundleIds, parseProjectVersion } from '../src/safari-xcode'

describe('parseProjectVersion', () => {
  it('encodes major/minor/patch into a single integer', () => {
    expect(parseProjectVersion('1.2.3')).toBe(10203)
    expect(parseProjectVersion('0.1.0')).toBe(100)
  })
})

describe('normaliseBundleIds', () => {
  it('replaces the shortest (parent app) id everywhere, preserving sub-target suffixes', () => {
    const content = [
      'PRODUCT_BUNDLE_IDENTIFIER = com.example.MyExt;',
      'PRODUCT_BUNDLE_IDENTIFIER = com.example.MyExt.Extension;',
    ].join('\n')
    // bundleIdentifier contains a hyphen, so quote() wraps every id it produces in quotes.
    const result = normaliseBundleIds(content, 'com.example.my-ext')
    expect(result).toContain('PRODUCT_BUNDLE_IDENTIFIER = "com.example.my-ext";')
    expect(result).toContain('PRODUCT_BUNDLE_IDENTIFIER = "com.example.my-ext.Extension";')
  })

  it('leaves a bare (no special characters) replacement id unquoted', () => {
    const content = 'PRODUCT_BUNDLE_IDENTIFIER = com.example.MyExt;'
    const result = normaliseBundleIds(content, 'com.example.myext')
    expect(result).toBe('PRODUCT_BUNDLE_IDENTIFIER = com.example.myext;')
  })

  it('is a no-op when the stem already matches the requested bundle identifier', () => {
    const content = 'PRODUCT_BUNDLE_IDENTIFIER = com.example.my-ext;'
    expect(normaliseBundleIds(content, 'com.example.my-ext')).toBe(content)
  })

  it('is a no-op when there are no bundle identifiers to normalise', () => {
    const content = 'MARKETING_VERSION = 1.0;'
    expect(normaliseBundleIds(content, 'com.example.my-ext')).toBe(content)
  })

  it('leaves ids untouched when they do not share the mangled stem', () => {
    // The unrelated id must be longer than the real stem, or it gets
    // mistaken for the stem itself (the algorithm picks the shortest id).
    const content = [
      'PRODUCT_BUNDLE_IDENTIFIER = com.example.MyExt;',
      'PRODUCT_BUNDLE_IDENTIFIER = com.example.MyExt.Extension;',
      'PRODUCT_BUNDLE_IDENTIFIER = com.other.completely.unrelated;',
    ].join('\n')
    const result = normaliseBundleIds(content, 'com.example.my-ext')
    expect(result).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.other.completely.unrelated;')
  })
})
