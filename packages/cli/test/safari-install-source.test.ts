import { zipSync } from 'fflate'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCwsCrxUrl,
  extractZipFromCrx,
  parseCwsExtensionId,
  resolveExtensionSource,
  unzipExtensionSafely,
} from '../src/safari-install-source'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'extport-src-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function buildCrx3(zipBytes: Uint8Array, headerLength = 16): Uint8Array {
  const out = new Uint8Array(12 + headerLength + zipBytes.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x34327243, true) // 'Cr24'
  view.setUint32(4, 3, true)
  view.setUint32(8, headerLength, true)
  out.set(zipBytes, 12 + headerLength)
  return out
}

function buildCrx2(zipBytes: Uint8Array, pubKeyLen = 8, sigLen = 12): Uint8Array {
  const out = new Uint8Array(16 + pubKeyLen + sigLen + zipBytes.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x34327243, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, pubKeyLen, true)
  view.setUint32(12, sigLen, true)
  out.set(zipBytes, 16 + pubKeyLen + sigLen)
  return out
}

describe('parseCwsExtensionId', () => {
  const id = 'hlepfoohegkhhmjieoechaddaejaokhf'

  it('accepts a bare 32-char extension ID', () => {
    expect(parseCwsExtensionId(id)).toBe(id)
    expect(parseCwsExtensionId(`  ${id}  `)).toBe(id)
  })

  it('parses current chromewebstore.google.com URLs', () => {
    expect(parseCwsExtensionId(`https://chromewebstore.google.com/detail/refined-github/${id}`)).toBe(id)
    expect(parseCwsExtensionId(`https://chromewebstore.google.com/detail/${id}?hl=zh-CN#reviews`)).toBe(id)
  })

  it('parses legacy chrome.google.com/webstore URLs', () => {
    expect(parseCwsExtensionId(`https://chrome.google.com/webstore/detail/refined-github/${id}`)).toBe(id)
  })

  it('rejects non-CWS URLs and malformed IDs', () => {
    expect(parseCwsExtensionId('https://example.com/detail/' + id)).toBeUndefined()
    expect(parseCwsExtensionId('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeUndefined() // z outside a-p
    expect(parseCwsExtensionId('short')).toBeUndefined()
  })
})

describe('buildCwsCrxUrl', () => {
  it('builds the Chrome update2 redirect URL', () => {
    const url = buildCwsCrxUrl('hlepfoohegkhhmjieoechaddaejaokhf', '150.0.0.0')
    expect(url).toContain('clients2.google.com/service/update2/crx')
    expect(url).toContain('prodversion=150.0.0.0')
    expect(url).toContain('acceptformat=crx2%2Ccrx3')
    expect(url).toContain('x=id%3Dhlepfoohegkhhmjieoechaddaejaokhf%26uc')
  })
})

describe('extractZipFromCrx', () => {
  const sampleZip = zipSync({ 'manifest.json': new TextEncoder().encode('{"manifest_version":3}') })

  it('strips a CRX3 header', () => {
    expect(extractZipFromCrx(buildCrx3(sampleZip))).toEqual(sampleZip)
  })

  it('strips a CRX2 header', () => {
    expect(extractZipFromCrx(buildCrx2(sampleZip))).toEqual(sampleZip)
  })

  it('rejects non-CRX bytes and truncated headers', () => {
    expect(() => extractZipFromCrx(new Uint8Array([1, 2, 3, 4]))).toThrow(/truncated/)
    expect(() => extractZipFromCrx(new Uint8Array(32))).toThrow(/Cr24/)
  })
})

describe('unzipExtensionSafely', () => {
  it('unpacks a flat zip directly', async () => {
    const dir = await makeTempDir()
    const zip = zipSync({
      'manifest.json': new TextEncoder().encode('{"manifest_version":3,"name":"Test"}'),
      'bg.js': new TextEncoder().encode('console.log(1)'),
    })
    const unpacked = await unzipExtensionSafely(zip, dir)
    expect(unpacked).toBe(path.resolve(dir))
    expect(existsSync(path.join(unpacked, 'manifest.json'))).toBe(true)
  })

  it('descends into a single wrapper directory containing manifest.json', async () => {
    const dir = await makeTempDir()
    const zip = zipSync({
      'my-ext/manifest.json': new TextEncoder().encode('{"manifest_version":3,"name":"Wrapped"}'),
      '__MACOSX/._my-ext': new Uint8Array([0]),
    })
    const unpacked = await unzipExtensionSafely(zip, dir)
    expect(unpacked).toBe(path.join(path.resolve(dir), 'my-ext'))
  })

  it('rejects Zip Slip entries escaping the destination', async () => {
    const dir = await makeTempDir()
    const zip = zipSync({
      '../evil.txt': new TextEncoder().encode('pwn'),
    })
    await expect(unzipExtensionSafely(zip, dir)).rejects.toThrow(/unsafe archive path/)
  })
})

describe('resolveExtensionSource', () => {
  it('downloads and unpacks a CWS extension via URL', async () => {
    const workDir = await makeTempDir()
    const zip = zipSync({ 'manifest.json': new TextEncoder().encode('{"manifest_version":3,"name":"CWS Demo"}') })
    const crx = buildCrx3(zip)
    const id = 'hlepfoohegkhhmjieoechaddaejaokhf'

    const resolved = await resolveExtensionSource(`https://chromewebstore.google.com/detail/demo/${id}`, workDir, {
      fetch: async () => new Response(Buffer.from(crx), { status: 200 }),
      log: () => {},
    })
    expect(resolved.cwsId).toBe(id)
    expect(await readFile(path.join(resolved.unpackedDir, 'manifest.json'), 'utf-8')).toContain('CWS Demo')
  })

  it('reports a clear error on HTTP 204 from CWS', async () => {
    const workDir = await makeTempDir()
    await expect(
      resolveExtensionSource('hlepfoohegkhhmjieoechaddaejaokhf', workDir, {
        fetch: async () => new Response(null, { status: 204 }),
        log: () => {},
      }),
    ).rejects.toThrow(/204 No Content/)
  })

  it('accepts a local unpacked directory and local .crx file', async () => {
    const workDir = await makeTempDir()
    const extDir = path.join(workDir, 'ext')
    await mkdir(extDir, { recursive: true })
    await writeFile(path.join(extDir, 'manifest.json'), '{"manifest_version":3,"name":"Local"}')

    const fromDir = await resolveExtensionSource(extDir, path.join(workDir, 'w1'), { log: () => {} })
    expect(fromDir.unpackedDir).toBe(extDir)

    const crxPath = path.join(workDir, 'sample.crx')
    await writeFile(
      crxPath,
      buildCrx3(zipSync({ 'manifest.json': new TextEncoder().encode('{"manifest_version":3,"name":"CRX"}') })),
    )
    const fromCrx = await resolveExtensionSource(crxPath, path.join(workDir, 'w2'), { log: () => {} })
    expect(fromCrx.fallbackName).toBe('sample')
    expect(existsSync(path.join(fromCrx.unpackedDir, 'manifest.json'))).toBe(true)
  })
})
