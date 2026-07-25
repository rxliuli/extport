import { zipSync } from 'fflate'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inferPushDefaults, readPackageJson, readZipManifestVersion, wxtZipPath } from '../src/wxt-project'

describe('wxtZipPath', () => {
  it('matches WXT\'s default zip.artifactTemplate ("{{name}}-{{version}}-{{browser}}.zip") under .output/', () => {
    expect(wxtZipPath('scrub', '0.0.14', 'chrome')).toBe(join('.output', 'scrub-0.0.14-chrome.zip'))
  })
})

function makeZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) entries[name] = new TextEncoder().encode(content)
  return zipSync(entries)
}

describe('readZipManifestVersion / readPackageJson / inferPushDefaults', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'extport-cli-wxt-test-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('reads the version out of a zip\'s manifest.json', async () => {
    const zipPath = join(cwd, 'ext.zip')
    await writeFile(zipPath, makeZip({ 'manifest.json': JSON.stringify({ manifest_version: 3, version: '1.2.3' }) }))
    expect(await readZipManifestVersion(zipPath)).toBe('1.2.3')
  })

  it('returns undefined for a missing file, a non-zip file, or a zip with no manifest.json', async () => {
    expect(await readZipManifestVersion(join(cwd, 'nope.zip'))).toBeUndefined()

    const notAZip = join(cwd, 'not-a-zip.zip')
    await writeFile(notAZip, 'just text')
    expect(await readZipManifestVersion(notAZip)).toBeUndefined()

    const empty = join(cwd, 'empty.zip')
    await writeFile(empty, makeZip({ 'background.js': 'console.log(1)' }))
    expect(await readZipManifestVersion(empty)).toBeUndefined()
  })

  it('reads package.json, and returns undefined when absent or invalid', async () => {
    expect(await readPackageJson(cwd)).toBeUndefined()
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'scrub', version: '0.0.14' }))
    expect(await readPackageJson(cwd)).toEqual({ name: 'scrub', version: '0.0.14' })
  })

  it('infers file and version from the conventional .output/ zip when neither is given', async () => {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'scrub', version: '0.0.14' }))
    await mkdir(join(cwd, '.output'), { recursive: true })
    await writeFile(join(cwd, '.output', 'scrub-0.0.14-chrome.zip'), makeZip({ 'manifest.json': JSON.stringify({ version: '0.0.14' }) }))

    const result = await inferPushDefaults({}, 'chrome', cwd)
    expect(result.file).toBe(join('.output', 'scrub-0.0.14-chrome.zip'))
    expect(result.version).toBe('0.0.14')
  })

  it('falls back to the chrome zip for --store edge when no dedicated edge zip was built', async () => {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'scrub', version: '0.0.14' }))
    await mkdir(join(cwd, '.output'), { recursive: true })
    await writeFile(join(cwd, '.output', 'scrub-0.0.14-chrome.zip'), makeZip({ 'manifest.json': JSON.stringify({ version: '0.0.14' }) }))

    const result = await inferPushDefaults({}, 'edge', cwd)
    expect(result.file).toBe(join('.output', 'scrub-0.0.14-chrome.zip'))
    expect(result.version).toBe('0.0.14')
  })

  it('prefers a dedicated edge zip over the chrome fallback when one was actually built', async () => {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'scrub', version: '0.0.14' }))
    await mkdir(join(cwd, '.output'), { recursive: true })
    await writeFile(join(cwd, '.output', 'scrub-0.0.14-chrome.zip'), makeZip({ 'manifest.json': JSON.stringify({ version: '0.0.14' }) }))
    await writeFile(join(cwd, '.output', 'scrub-0.0.14-edge.zip'), makeZip({ 'manifest.json': JSON.stringify({ version: '0.0.14' }) }))

    const result = await inferPushDefaults({}, 'edge', cwd)
    expect(result.file).toBe(join('.output', 'scrub-0.0.14-edge.zip'))
  })

  it('leaves file undefined for --store edge when neither an edge nor a chrome zip exists', async () => {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'scrub', version: '0.0.14' }))
    const result = await inferPushDefaults({}, 'edge', cwd)
    expect(result.file).toBeUndefined()
  })

  it('does not guess a file for --store safari (no zip travels through extport)', async () => {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'scrub', version: '0.0.14' }))
    const result = await inferPushDefaults({}, 'safari', cwd)
    expect(result.file).toBeUndefined()
    expect(result.version).toBe('0.0.14')
  })

  it('leaves file undefined when the conventional path does not exist on disk', async () => {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'scrub', version: '0.0.14' }))
    const result = await inferPushDefaults({}, 'chrome', cwd)
    expect(result.file).toBeUndefined()
  })

  it('reads version from an explicitly-given --file rather than the guessed one', async () => {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'scrub', version: '0.0.14' }))
    const explicit = join(cwd, 'custom.zip')
    await writeFile(explicit, makeZip({ 'manifest.json': JSON.stringify({ version: '9.9.9' }) }))

    const result = await inferPushDefaults({ file: explicit }, 'chrome', cwd)
    expect(result.file).toBeUndefined() // raw.file already set — inference only fills what's missing
    expect(result.version).toBe('9.9.9')
  })

  it('never overrides an explicitly-given --version', async () => {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'scrub', version: '0.0.14' }))
    await mkdir(join(cwd, '.output'), { recursive: true })
    await writeFile(join(cwd, '.output', 'scrub-0.0.14-chrome.zip'), makeZip({ 'manifest.json': JSON.stringify({ version: '0.0.14' }) }))

    const result = await inferPushDefaults({ version: '5.0.0' }, 'chrome', cwd)
    expect(result.version).toBeUndefined()
  })
})
