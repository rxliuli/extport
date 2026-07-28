import { strToU8, zipSync } from 'fflate'

// Pinned so identical inputs produce byte-identical zips (fflate rejects dates before 1980).
const FIXED_MTIME = new Date('2020-01-01T00:00:00Z')
import { describe, expect, it } from 'vitest'
import { parseZipManifest, validateArtifactManifest, type ExtensionManifest } from '../src/manifest'

function zipWith(manifest: object | string | null): Uint8Array {
  const files: Record<string, Uint8Array> = { 'other.txt': strToU8('hi') }
  if (manifest !== null) {
    files['manifest.json'] = strToU8(typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  }
  return zipSync(files, { mtime: FIXED_MTIME })
}

describe('parseZipManifest', () => {
  it('reads manifest.json from the zip root', () => {
    const manifest = parseZipManifest(zipWith({ manifest_version: 3, version: '1.2.3' }))
    expect(manifest).toEqual({ manifest_version: 3, version: '1.2.3' })
  })

  it('returns null for a zip without manifest.json, invalid JSON, or non-zip bytes', () => {
    expect(parseZipManifest(zipWith(null))).toBeNull()
    expect(parseZipManifest(zipWith('{oops'))).toBeNull()
    expect(parseZipManifest(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })

  it('ignores a manifest.json nested inside a directory', () => {
    const bytes = zipSync({ 'dist/manifest.json': strToU8('{"version":"1.0"}') }, { mtime: FIXED_MTIME })
    expect(parseZipManifest(bytes)).toBeNull()
  })
})

describe('validateArtifactManifest', () => {
  const chromeManifest: ExtensionManifest = {
    manifest_version: 3,
    version: '1.2.3',
    background: { service_worker: 'background.js' },
  }
  const firefoxManifest: ExtensionManifest = {
    manifest_version: 3,
    version: '1.2.3',
    background: { scripts: ['background.js'] },
    browser_specific_settings: { gecko: { id: 'ext@example.com' } },
  }

  it('rejects a missing manifest outright', () => {
    const errors = validateArtifactManifest(null, '1.2.3', [])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/no parseable manifest\.json/)
  })

  it('accepts matching builds', () => {
    expect(validateArtifactManifest(chromeManifest, '1.2.3', ['chrome', 'edge'])).toEqual([])
    expect(validateArtifactManifest(firefoxManifest, '1.2.3', ['firefox'])).toEqual([])
  })

  it('treats trailing-zero version differences as equal', () => {
    expect(validateArtifactManifest({ ...chromeManifest, version: '1.2' }, '1.2.0', ['chrome'])).toEqual([])
  })

  it('flags a version mismatch even with no target stores', () => {
    const errors = validateArtifactManifest(chromeManifest, '2.0.0', [])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/declares version 1\.2\.3 but this push is for 2\.0\.0/)
  })

  it('rejects a Chrome-style build headed for firefox, with both reasons', () => {
    const errors = validateArtifactManifest(chromeManifest, '1.2.3', ['firefox'])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatch(/gecko\.id/)
    expect(errors[1]).toMatch(/background\.scripts/)
  })

  it('honors the legacy applications.gecko.id alias', () => {
    const manifest: ExtensionManifest = { ...firefoxManifest, browser_specific_settings: undefined, applications: { gecko: { id: 'ext@example.com' } } }
    expect(validateArtifactManifest(manifest, '1.2.3', ['firefox'])).toEqual([])
  })

  it('allows a dual background (service_worker + scripts) for firefox', () => {
    const manifest: ExtensionManifest = { ...firefoxManifest, background: { service_worker: 'sw.js', scripts: ['bg.js'] } }
    expect(validateArtifactManifest(manifest, '1.2.3', ['firefox'])).toEqual([])
  })

  it('allows a firefox build with no background at all', () => {
    expect(validateArtifactManifest({ ...firefoxManifest, background: undefined }, '1.2.3', ['firefox'])).toEqual([])
  })

  it('rejects Manifest V2 for chrome but not for edge or firefox', () => {
    const mv2: ExtensionManifest = { ...firefoxManifest, manifest_version: 2 }
    expect(validateArtifactManifest(mv2, '1.2.3', ['chrome']).some((e) => e.includes('Manifest V3'))).toBe(true)
    expect(validateArtifactManifest(mv2, '1.2.3', ['edge', 'firefox'])).toEqual([])
  })

  it('contributes no store checks for safari', () => {
    expect(validateArtifactManifest(chromeManifest, '1.2.3', ['safari'])).toEqual([])
  })
})
