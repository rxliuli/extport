import { unzipSync } from 'fflate'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveFirefoxPortOptions } from '../src/firefox-port-args'
import {
  buildDeterministicGeckoId,
  detectUnsupportedFirefoxApis,
  inspectFirefoxManifest,
  isValidGeckoId,
  slugifyFilename,
} from '../src/firefox-port-manifest'
import { resolveFirefoxOutputPath, runFirefoxPort } from '../src/firefox-port'
import { discoverFirefoxBinaries, installTemporaryAddonViaRdp, resolveFirefoxBinary } from '../src/firefox-port-runner'

const tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'extport-ff-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('resolveFirefoxPortOptions', () => {
  it('validates source, gecko-id, min-version, --unpacked, and --firefox/--run coupling', () => {
    expect(resolveFirefoxPortOptions({ source: 'ddkjiahejlhfcafbddmgiahcphecmpfh' })).toMatchObject({
      source: 'ddkjiahejlhfcafbddmgiahcphecmpfh',
      unpacked: false,
      run: false,
      debug: false,
    })

    expect(() => resolveFirefoxPortOptions({ source: '  ' })).toThrow(/<source> is required/)
    expect(() => resolveFirefoxPortOptions({ source: 'x', unpacked: true, output: './out/ext.xpi' })).toThrow(
      /--unpacked cannot be combined/,
    )
    expect(() => resolveFirefoxPortOptions({ source: 'x', geckoId: 'not-valid' })).toThrow(/--gecko-id/)
    expect(() => resolveFirefoxPortOptions({ source: 'x', minVersion: 'abc' })).toThrow(/--min-version/)
    expect(() => resolveFirefoxPortOptions({ source: 'x', firefox: 'nightly' })).toThrow(/only valid with --run/)

    expect(
      resolveFirefoxPortOptions({
        source: 'x',
        geckoId: '{a4c4eda4-fb84-4a84-b4a1-f7c1cbf2a1ad}',
        minVersion: '133.0',
        run: true,
        firefox: 'dev',
      }),
    ).toMatchObject({
      geckoId: '{a4c4eda4-fb84-4a84-b4a1-f7c1cbf2a1ad}',
      minVersion: '133.0',
      run: true,
      firefox: 'dev',
    })
  })
})

describe('firefox-port-manifest', () => {
  it('validates email-like and UUID gecko IDs and builds deterministic IDs', () => {
    expect(isValidGeckoId('my-ext@port.extport.dev')).toBe(true)
    expect(isValidGeckoId('{a4c4eda4-fb84-4a84-b4a1-f7c1cbf2a1ad}')).toBe(true)
    expect(isValidGeckoId('plain-name')).toBe(false)

    expect(buildDeterministicGeckoId({ cwsId: 'ddkjiahejlhfcafbddmgiahcphecmpfh', appName: 'uBO Lite' })).toBe(
      'ddkjiahejlhfcafbddmgiahcphecmpfh@port.extport.dev',
    )
    expect(
      buildDeterministicGeckoId({
        cwsId: 'hlepfoohegkhhmjieoechaddaejaokhf',
        appName: 'Refined GitHub',
        existingGeckoId: '{a4c4eda4-fb84-4a84-b4a1-f7c1cbf2a1ad}',
      }),
    ).toBe('{a4c4eda4-fb84-4a84-b4a1-f7c1cbf2a1ad}')
    expect(buildDeterministicGeckoId({ appName: '测试扩展' })).toMatch(/^ext-[0-9a-f]{8}@port\.extport\.dev$/)
    expect(slugifyFilename('Dark Reader', 'fallback')).toBe('dark-reader')
  })

  it('warns on Chrome-only APIs unsupported by Firefox', () => {
    const warnings = detectUnsupportedFirefoxApis({
      permissions: ['storage', 'offscreen', 'fontSettings', 'userScripts'],
      sandbox: { pages: ['s.html'] },
      oauth2: { client_id: 'x' },
    })
    expect(warnings.map((w) => w.api)).toEqual(['chrome.offscreen', 'chrome.fontSettings', 'sandbox', 'oauth2'])
  })

  it('rejects MV2 and resolves localized names + existing gecko settings', async () => {
    const dir = await makeTempDir()
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ manifest_version: 2, name: 'V2', version: '1.0' }),
    )
    await expect(inspectFirefoxManifest(dir, 'v2')).rejects.toThrow(/only Manifest V3/)

    await mkdir(path.join(dir, '_locales', 'en'), { recursive: true })
    await writeFile(
      path.join(dir, '_locales', 'en', 'messages.json'),
      JSON.stringify({ extName: { message: 'uBlock Origin Lite' } }),
    )
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: '__MSG_extName__',
        default_locale: 'en',
        version: '2026.1124.1811',
        browser_specific_settings: { gecko: { id: 'ubo@example.org', strict_min_version: '130.0' } },
      }),
    )
    const meta = await inspectFirefoxManifest(dir, 'fallback')
    expect(meta.appName).toBe('uBlock Origin Lite')
    expect(meta.existingGeckoId).toBe('ubo@example.org')
    expect(meta.existingMinVersion).toBe('130.0')
  })
})

describe('firefox-port-runner discovery & RDP client', () => {
  it('discovers Firefox binaries across macOS/Linux and resolves channel aliases', () => {
    const macFound = discoverFirefoxBinaries({
      platform: 'darwin',
      homedir: '/Users/test',
      exists: (p) =>
        p === '/Applications/Firefox.app/Contents/MacOS/firefox' || p === '/Applications/Zen.app/Contents/MacOS/zen',
    })
    expect(macFound.map((b) => b.channel)).toEqual(['firefox', 'zen'])
    expect(resolveFirefoxBinary('zen', macFound).executablePath).toBe('/Applications/Zen.app/Contents/MacOS/zen')
    expect(resolveFirefoxBinary(undefined, macFound).channel).toBe('firefox')
    expect(() => resolveFirefoxBinary('nightly', macFound)).toThrow(/not found/)
  })

  it('speaks Firefox RDP length-prefixed framing to install a temporary add-on and read warnings', async () => {
    const server = net.createServer((socket) => {
      const send = (obj: Record<string, unknown>) => {
        const s = JSON.stringify(obj)
        socket.write(`${Buffer.byteLength(s, 'utf-8')}:${s}`)
      }
      send({ from: 'root', applicationType: 'browser' })

      let buf = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
        while (true) {
          const colon = buf.indexOf(0x3a)
          if (colon === -1) break
          const len = Number.parseInt(buf.subarray(0, colon).toString('ascii'), 10)
          if (buf.length < colon + 1 + len) break
          const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString('utf-8')) as Record<string, unknown>
          buf = buf.subarray(colon + 1 + len)
          if (msg.type === 'getRoot') {
            send({ from: 'root', addonsActor: 'server1.addonsActor' })
          } else if (msg.type === 'installTemporaryAddon') {
            // Send an unsolicited event first to verify framing skips events cleanly.
            send({ from: 'root', type: 'addonListChanged' })
            send({ from: 'server1.addonsActor', addon: { id: 'demo@port.extport.dev' } })
          } else if (msg.type === 'listAddons') {
            send({
              from: 'root',
              addons: [
                {
                  id: 'demo@port.extport.dev',
                  backgroundScriptStatus: 'RUNNING',
                  warnings: ['Sample warning'],
                },
              ],
            })
          }
        }
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as net.AddressInfo
    try {
      const res = await installTemporaryAddonViaRdp(addr.port, '/tmp/demo-ext')
      expect(res).toEqual({
        addonId: 'demo@port.extport.dev',
        backgroundScriptStatus: 'RUNNING',
        warnings: ['Sample warning'],
      })
    } finally {
      server.close()
    }
  })
})

describe('runFirefoxPort end-to-end packaging', () => {
  it('converts a local Chrome MV3 directory into a valid .xpi without mutating the source', async () => {
    const srcDir = await makeTempDir()
    const outDir = await makeTempDir()
    await writeFile(path.join(srcDir, 'sw.js'), 'console.log("bg");\n')
    await writeFile(path.join(srcDir, 'popup.html'), '<!doctype html><html><head></head><body>Hi</body></html>')
    const origManifest = JSON.stringify({
      manifest_version: 3,
      name: 'Demo Extension',
      version: '1.0.0',
      background: { service_worker: 'sw.js' },
      action: { default_popup: 'popup.html' },
      permissions: ['storage', 'offscreen'],
    })
    await writeFile(path.join(srcDir, 'manifest.json'), origManifest)

    const logs: string[] = []
    const result = await runFirefoxPort(resolveFirefoxPortOptions({ source: srcDir, output: outDir }), {
      log: (m) => logs.push(m),
      cwd: outDir,
    })

    expect(result.geckoId).toBe('demo-extension@port.extport.dev')
    expect(result.outputPath).toBe(path.join(outDir, 'demo-extension-firefox.xpi'))
    expect(await readFile(path.join(srcDir, 'manifest.json'), 'utf-8')).toBe(origManifest)

    const xpiBytes = new Uint8Array(await readFile(result.outputPath!))
    const entries = unzipSync(xpiBytes)
    expect(entries['manifest.json']).toBeDefined()
    expect(entries['__extport_firefox_runtime.js']).toBeDefined()
    const convertedManifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString('utf-8'))
    expect(convertedManifest.background).toEqual({ scripts: ['__extport_firefox_runtime.js', 'sw.js'] })
    expect(convertedManifest.permissions).toEqual(['storage'])
    expect(convertedManifest.browser_specific_settings.gecko.id).toBe('demo-extension@port.extport.dev')

    expect(resolveFirefoxOutputPath({ cwd: '/tmp', slug: 'foo', unpacked: false })).toBe('/tmp/foo-firefox.xpi')
    expect(resolveFirefoxOutputPath({ cwd: '/tmp', slug: 'foo', unpacked: true })).toBe('/tmp/foo-firefox')
  })
})
