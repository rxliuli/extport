import { describe, expect, it } from 'vitest'
import { mergeDataCollectionPermissions, normalizeOptions, pluginSource } from './index'

describe('normalizeOptions', () => {
  it('reads the nested shape', () => {
    const result = normalizeOptions({
      extension: 'ext_a',
      analytics: true,
      safari: { appCategory: 'cat', bundleIdentifier: 'com.x.y', developmentTeam: 'T1' },
    })
    expect(result).toEqual({
      extension: 'ext_a',
      analytics: true,
      safari: { appCategory: 'cat', bundleIdentifier: 'com.x.y', developmentTeam: 'T1' },
    })
  })

  it('handles a missing options object', () => {
    expect(normalizeOptions(undefined)).toEqual({ extension: undefined, analytics: false, safari: undefined })
  })
})

describe('pluginSource', () => {
  it('always sets the injected global', () => {
    const source = pluginSource('ext_a', false)
    expect(source).toContain('globalThis.__EXTPORT__ = { extensionId: "ext_a" }')
    expect(source).not.toContain('@extport/sdk/analytics')
  })

  it('gates the analytics attach on the background entrypoint', () => {
    const source = pluginSource('ext_a', true)
    expect(source).toContain("import.meta.env.ENTRYPOINT === 'background'")
    expect(source).toContain("import('@extport/sdk/analytics')")
    // The global is set before the attach so the SDK's resolution finds it.
    expect(source.indexOf('__EXTPORT__')).toBeLessThan(source.indexOf('@extport/sdk/analytics'))
  })
})

describe('mergeDataCollectionPermissions', () => {
  it('creates the full declaration on a bare manifest', () => {
    const manifest: Record<string, unknown> = {}
    mergeDataCollectionPermissions(manifest)
    expect(manifest).toEqual({
      browser_specific_settings: {
        gecko: {
          data_collection_permissions: { required: ['none'], optional: ['technicalAndInteraction'] },
        },
      },
    })
  })

  it('preserves existing gecko settings and declarations', () => {
    const manifest: Record<string, unknown> = {
      browser_specific_settings: {
        gecko: {
          id: 'x@example.com',
          data_collection_permissions: { required: ['locationInfo'], optional: ['bookmarksInfo'] },
        },
      },
    }
    mergeDataCollectionPermissions(manifest)
    const gecko = (manifest.browser_specific_settings as { gecko: Record<string, unknown> }).gecko
    expect(gecko.id).toBe('x@example.com')
    expect(gecko.data_collection_permissions).toEqual({
      required: ['locationInfo'],
      optional: ['bookmarksInfo', 'technicalAndInteraction'],
    })
  })

  it('is idempotent', () => {
    const manifest: Record<string, unknown> = {}
    mergeDataCollectionPermissions(manifest)
    mergeDataCollectionPermissions(manifest)
    const gecko = (manifest.browser_specific_settings as { gecko: { data_collection_permissions: { optional: string[] } } }).gecko
    expect(gecko.data_collection_permissions.optional).toEqual(['technicalAndInteraction'])
  })
})
