import { describe, expect, it } from 'vitest'
import { ID_PREFIXES, newId } from '../src/id'

describe('newId', () => {
  it('prefixes ids by kind', () => {
    expect(newId('tenant')).toMatch(/^ten_[0-9a-zA-Z]{20}$/)
    expect(newId('extension')).toMatch(/^ext_[0-9a-zA-Z]{20}$/)
    expect(newId('license')).toMatch(/^lic_[0-9a-zA-Z]{20}$/)
  })

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('artifact')))
    expect(ids.size).toBe(1000)
  })

  it('has unique prefixes across all kinds', () => {
    const prefixes = Object.values(ID_PREFIXES)
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })
})
