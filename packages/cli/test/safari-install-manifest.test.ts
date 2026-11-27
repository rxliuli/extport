import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDeterministicBundleId,
  detectUnsupportedSafariApis,
  inspectExtensionManifest,
  normalizeExtensionVersion,
  sanitizeAppName,
} from '../src/safari-install-manifest'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'extport-manifest-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('normalizeExtensionVersion', () => {
  it('caps to 3 numeric segments and strips leading zeros', () => {
    expect(normalizeExtensionVersion('1.2.3.4')).toBe('1.2.3')
    expect(normalizeExtensionVersion('2026.05.01')).toBe('2026.5.1')
    expect(normalizeExtensionVersion('2.0')).toBe('2.0')
    expect(normalizeExtensionVersion(undefined)).toBe('1.0.0')
  })
})

describe('sanitizeAppName', () => {
  it('strips illegal path characters and collapses whitespace', () => {
    expect(sanitizeAppName('Foo/Bar: Baz', 'Fallback')).toBe('Foo Bar Baz')
    expect(sanitizeAppName('   ', 'Fallback')).toBe('Fallback')
  })
})

describe('buildDeterministicBundleId', () => {
  it('scopes by teamId and prefers the CWS extension ID', () => {
    expect(
      buildDeterministicBundleId({
        cwsId: 'hlepfoohegkhhmjieoechaddaejaokhf',
        appName: 'Refined GitHub',
        teamId: 'N2X78TUUFG',
      }),
    ).toBe('dev.extport.n2x78tuufg.hlepfoohegkhhmjieoechaddaejaokhf')
  })

  it('uses local scope when unsigned and hashes non-ASCII local names deterministically', () => {
    const a = buildDeterministicBundleId({ appName: '测试扩展' })
    const b = buildDeterministicBundleId({ appName: '测试扩展' })
    expect(a).toBe(b)
    expect(a).toMatch(/^dev\.extport\.local\.ext-[0-9a-f]{8}$/)
  })
})

describe('detectUnsupportedSafariApis', () => {
  it('warns on identity, offscreen, and sidePanel (both permission and manifest key)', () => {
    const warnings = detectUnsupportedSafariApis({
      permissions: ['storage', 'identity', 'offscreen'],
      optional_permissions: ['sidePanel'],
      side_panel: { default_path: 'side.html' },
    })
    expect(warnings.map((w) => w.api)).toEqual(['chrome.identity', 'chrome.offscreen', 'chrome.sidePanel'])
  })

  it('returns empty for Safari-compatible permissions', () => {
    expect(detectUnsupportedSafariApis({ permissions: ['storage', 'tabs', 'scripting'] })).toEqual([])
  })
})

describe('inspectExtensionManifest', () => {
  it('rejects Manifest V2 extensions', async () => {
    const dir = await makeTempDir()
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ manifest_version: 2, name: 'Old Ext', version: '1.0' }),
    )
    await expect(inspectExtensionManifest(dir, 'old')).rejects.toThrow(/only Manifest V3 extensions are supported/)
  })

  it('resolves __MSG_*__ names case-insensitively from default_locale', async () => {
    const dir = await makeTempDir()
    await mkdir(path.join(dir, '_locales', 'en'), { recursive: true })
    await writeFile(
      path.join(dir, '_locales', 'en', 'messages.json'),
      JSON.stringify({ appName: { message: 'Refined GitHub' } }),
    )
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: '__MSG_APPNAME__',
        default_locale: 'en',
        version: '26.11.27.1',
        permissions: ['offscreen', 'storage'],
      }),
    )

    const meta = await inspectExtensionManifest(dir, 'fallback')
    expect(meta.appName).toBe('Refined GitHub')
    expect(meta.version).toBe('26.11.27')
    expect(meta.warnings.map((w) => w.api)).toEqual(['chrome.offscreen'])
  })
})
