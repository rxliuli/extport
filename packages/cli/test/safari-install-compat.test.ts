import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMPAT_BG_WRAPPER_NAME,
  COMPAT_RUNTIME_SCRIPT_NAME,
  COMPAT_STYLESHEET_NAME,
  IOS_RENAMED_RESOURCES_DIR,
  buildSafariCompatCss,
  buildSafariRuntimeShim,
  collectExtensionHtmlPages,
  normalizeManifestForSafari,
  patchExtensionForSafari,
  patchHtmlDocument,
} from '../src/safari-install-compat'

describe('collectExtensionHtmlPages', () => {
  it('extracts and deduplicates popup and options pages while stripping leading slashes and query strings', () => {
    const pages = collectExtensionHtmlPages({
      action: { default_popup: '/pages/popup.html?tab=1#top' },
      options_page: './pages/options.html',
      options_ui: { page: 'pages/options.html' },
    })
    expect(pages).toEqual(['pages/popup.html', 'pages/options.html'])
  })

  it('ignores empty values and external URLs', () => {
    const pages = collectExtensionHtmlPages({
      action: { default_popup: 'https://example.com/popup.html' },
      options_page: '   ',
      options_ui: { page: 'options.html' },
    })
    expect(pages).toEqual(['options.html'])
  })
})

describe('buildSafariCompatCss', () => {
  it('wraps color-scheme in a cascade layer on both platforms and includes narrow-viewport reflow on iOS', () => {
    const iosCss = buildSafariCompatCss('ios')
    expect(iosCss).toContain('@layer extport-compat')
    expect(iosCss).toContain('color-scheme: light dark;')
    expect(iosCss).toContain('@media (max-width: 500px)')
    expect(iosCss).toContain('min-inline-size: 0 !important;')
    expect(iosCss).toContain('max-inline-size: 100% !important;')
    expect(iosCss).not.toContain('overflow-x: hidden')

    const macCss = buildSafariCompatCss('macos')
    expect(macCss).toContain('@layer extport-compat')
    expect(macCss).toContain('color-scheme: light dark;')
    expect(macCss).not.toContain('@media (max-width: 500px)')
  })
})

describe('patchHtmlDocument', () => {
  it('injects viewport and color-scheme metas early in <head> and stylesheet link before </head>', () => {
    const input = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="../stylesheets/popup.css" />
  </head>
  <body><div class="popup-container"></div></body>
</html>`
    const output = patchHtmlDocument(input, '../__extport_safari_compat.css')

    const headOpen = output.indexOf('<head>')
    const viewportIdx = output.indexOf('<meta name="viewport" content="width=device-width, initial-scale=1" />')
    const colorSchemeIdx = output.indexOf('<meta name="color-scheme" content="light dark" />')
    const existingCssIdx = output.indexOf('../stylesheets/popup.css')
    const compatCssIdx = output.indexOf('<link rel="stylesheet" href="../__extport_safari_compat.css" />')
    const headClose = output.indexOf('</head>')

    expect(viewportIdx).toBeGreaterThan(headOpen)
    expect(colorSchemeIdx).toBeGreaterThan(viewportIdx)
    expect(existingCssIdx).toBeGreaterThan(colorSchemeIdx)
    expect(compatCssIdx).toBeGreaterThan(existingCssIdx)
    expect(headClose).toBeGreaterThan(compatCssIdx)

    // Idempotent when called twice.
    expect(patchHtmlDocument(output, '../__extport_safari_compat.css')).toBe(output)
  })

  it('preserves existing viewport and color-scheme meta tags without duplicating them', () => {
    const input = `<!doctype html>
<html>
  <HEAD>
    <meta name='viewport' content='width=device-width, initial-scale=1.0'>
    <meta content="dark" name="color-scheme">
  </HEAD>
  <body></body>
</html>`
    const output = patchHtmlDocument(input, './__extport_safari_compat.css')

    expect(output.match(/name\s*=\s*['"]viewport['"]/gi)?.length).toBe(1)
    expect(output.match(/name\s*=\s*['"]color-scheme['"]/gi)?.length).toBe(1)
    expect(output).toContain('content="dark"')
    expect(output).toContain('<link rel="stylesheet" href="./__extport_safari_compat.css" />')
  })

  it('adds a <head> block when patching minimal HTML without one', () => {
    const output = patchHtmlDocument('<!doctype html><html><body>hi</body></html>', './__extport_safari_compat.css')
    expect(output).toContain('<head>')
    expect(output).toContain('<meta name="color-scheme" content="light dark" />')
    expect(output).toContain('<link rel="stylesheet" href="./__extport_safari_compat.css" />')
  })
})

describe('patchExtensionForSafari', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'extport-safari-compat-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the compat stylesheet and patches nested and root HTML pages with correct relative hrefs', async () => {
    await mkdir(path.join(dir, 'pages'), { recursive: true })
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Test Ext',
        version: '1.0.0',
        action: { default_popup: 'pages/popup.html' },
        options_page: 'options.html',
      }),
    )
    await writeFile(path.join(dir, 'pages', 'popup.html'), '<!doctype html><html><head></head><body></body></html>')
    await writeFile(path.join(dir, 'options.html'), '<!doctype html><html><head></head><body></body></html>')

    const patched = await patchExtensionForSafari(dir, 'ios')
    expect(patched).toEqual(['pages/popup.html', 'options.html'])

    const css = await readFile(path.join(dir, COMPAT_STYLESHEET_NAME), 'utf-8')
    expect(css).toContain('color-scheme: light dark;')
    expect(css).toContain('@media (max-width: 500px)')

    const popup = await readFile(path.join(dir, 'pages', 'popup.html'), 'utf-8')
    expect(popup).toContain('href="../__extport_safari_compat.css"')
    expect(popup).toContain('<meta name="color-scheme" content="light dark" />')
    expect(popup).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />')

    const options = await readFile(path.join(dir, 'options.html'), 'utf-8')
    expect(options).toContain('href="./__extport_safari_compat.css"')
  })

  it('ignores path traversal entries and missing HTML files', async () => {
    const parentFile = path.join(path.dirname(dir), 'outside.html')
    await writeFile(parentFile, '<html><head></head><body></body></html>')
    try {
      await writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify({
          manifest_version: 3,
          name: 'Test Ext',
          version: '1.0.0',
          action: { default_popup: '../outside.html' },
          options_page: 'missing.html',
        }),
      )
      const patched = await patchExtensionForSafari(dir, 'ios')
      expect(patched).toEqual([])
      expect(await readFile(parentFile, 'utf-8')).toBe('<html><head></head><body></body></html>')
    } finally {
      await rm(parentFile, { force: true })
    }
  })

  it('wires classic and module service workers, background.scripts, devtools_page, and BOM manifests', async () => {
    await mkdir(path.join(dir, 'build'), { recursive: true })
    await writeFile(
      path.join(dir, 'manifest.json'),
      '\uFEFF' +
        JSON.stringify({
          manifest_version: 3,
          name: 'Shim Test',
          version: '1.0.0',
          incognito: 'split',
          update_url: 'https://clients2.google.com/service/update2/crx',
          commands: {
            _execute_action: {},
            toggle: { description: 'Toggle' },
          },
          web_accessible_resources: [{ resources: ['a.js'], matches: ['<all_urls>'], use_dynamic_url: true }],
          background: { service_worker: 'build/sw.js', scripts: ['build/sw.js'], type: 'module' },
          devtools_page: 'devtools.html',
        }),
    )
    await writeFile(path.join(dir, 'build', 'sw.js'), 'export {}')
    await writeFile(path.join(dir, 'devtools.html'), '<!doctype html><html><head></head><body></body></html>')

    const patched = await patchExtensionForSafari(dir, 'macos')
    expect(patched).toEqual([])

    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf-8'))
    expect(manifest.incognito).toBeUndefined()
    expect(manifest.update_url).toBeUndefined()
    expect(manifest.commands).toEqual({ toggle: { description: 'Toggle' } })
    expect(manifest.web_accessible_resources).toEqual([{ resources: ['a.js'], matches: ['<all_urls>'] }])
    expect(manifest.background.service_worker).toBe(`build/${COMPAT_BG_WRAPPER_NAME}`)
    expect(manifest.background.scripts).toEqual([COMPAT_RUNTIME_SCRIPT_NAME, 'build/sw.js'])

    const wrapper = await readFile(path.join(dir, 'build', COMPAT_BG_WRAPPER_NAME), 'utf-8')
    expect(wrapper).toContain(`import "../${COMPAT_RUNTIME_SCRIPT_NAME}";`)
    expect(wrapper).toContain('import "./sw.js";')

    const devtools = await readFile(path.join(dir, 'devtools.html'), 'utf-8')
    expect(devtools).toContain(`<script src="./${COMPAT_RUNTIME_SCRIPT_NAME}"></script>`)
    expect(devtools).not.toContain(COMPAT_STYLESHEET_NAME)
  })

  it('relocates top-level resources/ directory on iOS and updates exact file references', async () => {
    await mkdir(path.join(dir, 'resources'), { recursive: true })
    await mkdir(path.join(dir, 'lib'), { recursive: true })
    await writeFile(path.join(dir, 'resources', 'tlds.txt'), 'com\norg\n')
    await writeFile(
      path.join(dir, 'lib', 'url.js'),
      'const p = "./resources/tlds.txt"; const other = "https://example.com/resources/api";',
    )
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Resources Test',
        version: '1.0.0',
        web_accessible_resources: [{ resources: ['resources/tlds.txt'], matches: ['<all_urls>'] }],
      }),
    )

    await patchExtensionForSafari(dir, 'ios')

    const relocated = await readFile(path.join(dir, IOS_RENAMED_RESOURCES_DIR, 'tlds.txt'), 'utf-8')
    expect(relocated).toBe('com\norg\n')
    const urlJs = await readFile(path.join(dir, 'lib', 'url.js'), 'utf-8')
    expect(urlJs).toContain(`./${IOS_RENAMED_RESOURCES_DIR}/tlds.txt`)
    expect(urlJs).toContain('https://example.com/resources/api')
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf-8'))
    expect(manifest.web_accessible_resources[0].resources).toEqual([`${IOS_RENAMED_RESOURCES_DIR}/tlds.txt`])
  })
})

describe('normalizeManifestForSafari & buildSafariRuntimeShim', () => {
  it('strips empty commands, incognito=split, use_dynamic_url, and Chrome-only metadata', () => {
    const manifest: Record<string, unknown> = {
      manifest_version: 3,
      incognito: 'split',
      update_url: 'https://example.com/crx',
      minimum_chrome_version: '120',
      $schema: 'https://json.schemastore.org/chrome-manifest',
      offline_enabled: true,
      commands: { _execute_action: {} },
      web_accessible_resources: [{ resources: ['x.js'], matches: ['<all_urls>'], use_dynamic_url: true }],
    }
    const changes = normalizeManifestForSafari(manifest)
    expect(changes.length).toBeGreaterThan(0)
    expect(manifest.commands).toBeUndefined()
    expect(manifest.incognito).toBeUndefined()
    expect(manifest.update_url).toBeUndefined()
    expect(manifest.minimum_chrome_version).toBeUndefined()
    expect(manifest.$schema).toBeUndefined()
    expect(manifest.offline_enabled).toBeUndefined()
    expect(manifest.web_accessible_resources).toEqual([{ resources: ['x.js'], matches: ['<all_urls>'] }])
  })

  it('runtime shim polyfills ExecutionWorld, webNavigation, webRequest ws:// filter, permissions.contains, and notifications', async () => {
    const receivedFilters: unknown[] = []
    const chromeMock: Record<string, unknown> = {
      runtime: {
        getManifest: () => ({ permissions: ['idle', 'storage'] }),
      },
      action: {},
      scripting: {},
      webNavigation: {},
      webRequest: {
        onBeforeRequest: {
          addListener: (_cb: unknown, filter: unknown) => {
            receivedFilters.push(filter)
          },
        },
      },
      permissions: {
        contains: async (details: { permissions?: string[] }) => {
          if (details.permissions?.includes('webRequestBlocking')) {
            throw new Error(
              "The 'permissions' value is invalid, because 'webRequestBlocking' is not a valid permission.",
            )
          }
          return true
        },
      },
      notifications: {
        onClicked: {
          addListener: () => {
            throw new Error('Notification clicked is not supported.')
          },
        },
      },
    }

    const sandbox: Record<string, unknown> = {
      chrome: chromeMock,
      browser: chromeMock,
      Promise,
      Object,
      Set,
      queueMicrotask,
    }
    sandbox.globalThis = sandbox
    vm.runInNewContext(buildSafariRuntimeShim(), sandbox)

    expect((chromeMock.scripting as { ExecutionWorld: Record<string, string> }).ExecutionWorld).toEqual({
      ISOLATED: 'ISOLATED',
      MAIN: 'MAIN',
    })

    const nav = chromeMock.webNavigation as {
      onHistoryStateUpdated: { addListener: (fn: () => void) => void; hasListener: (fn: () => void) => boolean }
      onReferenceFragmentUpdated: { addListener: (fn: () => void) => void; hasListener: (fn: () => void) => boolean }
    }
    const listener = () => {}
    nav.onHistoryStateUpdated.addListener(listener)
    nav.onReferenceFragmentUpdated.addListener(listener)
    expect(nav.onHistoryStateUpdated.hasListener(listener)).toBe(true)
    expect(nav.onReferenceFragmentUpdated.hasListener(listener)).toBe(true)

    const wr = chromeMock.webRequest as {
      OnBeforeSendHeadersOptions: Record<string, string>
      OnResponseStartedOptions: Record<string, string>
      onBeforeRequest: { addListener: (cb: () => void, filter: { urls: string[] }) => void }
    }
    expect(wr.OnBeforeSendHeadersOptions).toEqual({ REQUEST_HEADERS: 'requestHeaders' })
    expect('EXTRA_HEADERS' in wr.OnBeforeSendHeadersOptions).toBe(false)
    expect(wr.OnResponseStartedOptions).toEqual({ RESPONSE_HEADERS: 'responseHeaders' })
    wr.onBeforeRequest.addListener(() => {}, { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] })
    expect(receivedFilters).toEqual([{ urls: ['http://*/*', 'https://*/*'] }])

    const perms = chromeMock.permissions as { contains: (d: { permissions: string[] }) => Promise<boolean> }
    expect(await perms.contains({ permissions: ['webRequestBlocking'] })).toBe(false)
    expect(await perms.contains({ permissions: ['storage'] })).toBe(true)

    const notif = chromeMock.notifications as { onClicked: { addListener: (fn: () => void) => void } }
    expect(() => notif.onClicked.addListener(() => {})).not.toThrow()

    const action = chromeMock.action as {
      setBadgeTextColor: (d: { color: string }) => Promise<void>
      getBadgeTextColor: (d: Record<string, never>) => Promise<number[]>
    }
    await expect(action.setBadgeTextColor({ color: '#fff' })).resolves.toBeUndefined()
    await expect(action.getBadgeTextColor({})).resolves.toEqual([255, 255, 255, 255])

    const idle = chromeMock.idle as { queryState: (n: number) => Promise<string> }
    await expect(idle.queryState(60)).resolves.toBe('active')
  })
})
