import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMPAT_FIREFOX_BG_WRAPPER_NAME,
  COMPAT_FIREFOX_RUNTIME_NAME,
  buildFirefoxRuntimeShim,
  collectFirefoxHtmlPages,
  injectScriptIntoHtml,
  patchExtensionForFirefox,
  patchWebpackImportScriptsLoader,
  transformManifestForFirefox,
} from '../src/firefox-port-compat'

describe('transformManifestForFirefox', () => {
  it('converts service_worker to background.scripts, adds gecko settings, bridges side_panel & options_page, and cleans Chrome-only keys', () => {
    const manifest: Record<string, unknown> = {
      manifest_version: 3,
      name: 'Sample',
      version: '1.2.3',
      version_name: '1.2.3-beta',
      author: { email: 'dev@example.com' },
      update_url: 'https://clients2.google.com/service/update2/crx',
      key: 'MIIBIjANBgkqh...',
      minimum_chrome_version: '120',
      offline_enabled: true,
      $schema: 'https://json.schemastore.org/chrome-manifest',
      incognito: 'split',
      background: { service_worker: '/js/background.js', type: 'module' },
      options_page: 'dashboard.html',
      side_panel: { default_path: 'side.html' },
      action: { default_title: 'Sample', default_icon: 'icon.png', default_popup: 'popup.html' },
      permissions: [
        'storage',
        'commands',
        'offscreen',
        'sidePanel',
        'userScripts',
        'favicon',
        'chrome://favicon/',
        'declarativeNetRequest',
      ],
      optional_permissions: ['readingList', 'contextMenus', 'bookmarks'],
      web_accessible_resources: [
        { resources: ['a.js'], matches: ['<all_urls>'], use_dynamic_url: true, extension_ids: ['abc'] },
      ],
      content_security_policy: {
        extension_pages:
          "default-src 'none'; script-src 'self'; navigate-to 'self' https://example.com; style-src 'self'",
        sandbox: 'sandbox allow-scripts',
      },
      sandbox: { pages: ['sandbox.html'] },
      oauth2: { client_id: 'abc' },
      storage: { managed_schema: 'managed.json' },
    }

    const changes = transformManifestForFirefox(manifest, {
      geckoId: 'sample@port.extport.dev',
      minVersion: '128.0',
    })

    expect(changes.length).toBeGreaterThan(5)
    expect(manifest.author).toBe('dev@example.com')
    expect(manifest.version_name).toBeUndefined()
    expect(manifest.browser_specific_settings).toEqual({
      gecko: {
        id: 'sample@port.extport.dev',
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['none'] },
      },
    })
    expect(manifest.background).toEqual({ scripts: ['/js/background.js'], type: 'module' })
    expect(manifest.incognito).toBeUndefined()
    expect(manifest.options_page).toBeUndefined()
    expect(manifest.options_ui).toEqual({ page: 'dashboard.html', open_in_tab: true })
    expect(manifest.side_panel).toBeUndefined()
    expect(manifest.sidebar_action).toEqual({
      default_panel: 'side.html',
      default_title: 'Sample',
      default_icon: 'icon.png',
    })
    expect(manifest.permissions).toEqual(['storage', 'declarativeNetRequest', 'contextMenus'])
    expect(manifest.optional_permissions).toEqual(['bookmarks', 'userScripts'])
    expect(manifest.web_accessible_resources).toEqual([{ resources: ['a.js'], matches: ['<all_urls>'] }])
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "default-src 'none'; script-src 'self'; style-src 'self'",
    })
    expect(manifest.update_url).toBeUndefined()
    expect(manifest.key).toBeUndefined()
    expect(manifest.minimum_chrome_version).toBeUndefined()
    expect(manifest.offline_enabled).toBeUndefined()
    expect(manifest.$schema).toBeUndefined()
    expect(manifest.sandbox).toBeUndefined()
    expect(manifest.oauth2).toBeUndefined()
    expect(manifest.storage).toBeUndefined()
  })

  it('preserves existing options_ui, sidebar_action, and gecko.data_collection_permissions', () => {
    const manifest: Record<string, unknown> = {
      manifest_version: 3,
      name: 'Dual',
      version: '2.0.0',
      browser_specific_settings: {
        gecko: {
          id: 'existing@example.org',
          strict_min_version: '133.0',
          data_collection_permissions: { required: ['none'], optional: ['technicalAndInteraction'] },
        },
      },
      options_page: 'legacy.html',
      options_ui: { page: 'modern.html', open_in_tab: false },
      background: { scripts: ['bg.js'], service_worker: 'bg.js' },
    }

    transformManifestForFirefox(manifest, { geckoId: 'existing@example.org' })

    expect(manifest.browser_specific_settings).toEqual({
      gecko: {
        id: 'existing@example.org',
        strict_min_version: '133.0',
        data_collection_permissions: { required: ['none'], optional: ['technicalAndInteraction'] },
      },
    })
    expect(manifest.options_page).toBeUndefined()
    expect(manifest.options_ui).toEqual({ page: 'modern.html', open_in_tab: false })
    expect(manifest.background).toEqual({ scripts: ['bg.js'] })
  })
})

describe('collectFirefoxHtmlPages & injectScriptIntoHtml', () => {
  it('collects popup, options_ui, sidebar_action, and devtools_page', () => {
    expect(
      collectFirefoxHtmlPages({
        action: { default_popup: '/pages/popup.html?x=1' },
        options_ui: { page: './options.html' },
        sidebar_action: { default_panel: 'side.html' },
        devtools_page: 'devtools.html',
      }),
    ).toEqual(['pages/popup.html', 'options.html', 'side.html', 'devtools.html'])
  })

  it('injects runtime script early in <head> idempotently', () => {
    const html = '<!doctype html><html><head><title>Pop</title></head><body></body></html>'
    const once = injectScriptIntoHtml(html, './__extport_firefox_runtime.js')
    expect(once).toContain('<script src="./__extport_firefox_runtime.js"></script>')
    expect(once.indexOf('__extport_firefox_runtime.js')).toBeLessThan(once.indexOf('<title>'))
    expect(injectScriptIntoHtml(once, './__extport_firefox_runtime.js')).toBe(once)
  })
})

describe('buildFirefoxRuntimeShim', () => {
  it('bridges sidePanel -> sidebarAction, shims clients/ExecutionWorld/permissions.contains/badgeTextColor', async () => {
    let openedSidebar = false
    let setPanelArgs: unknown
    let dnrArgs: unknown
    const chromeMock: Record<string, unknown> = {
      sidebarAction: {
        open: async () => {
          openedSidebar = true
        },
        setPanel: async (details: unknown) => {
          setPanelArgs = details
        },
        getPanel: async () => 'side.html',
      },
      scripting: {},
      action: {},
      webRequest: {},
      declarativeNetRequest: {
        updateDynamicRules: async (opts: unknown) => {
          dnrArgs = opts
        },
      },
      permissions: {
        contains: async (d: { permissions?: string[] }) => {
          if (d.permissions?.includes('offscreen')) {
            throw new Error('Type error for parameter permissions: Value "offscreen" must either ...')
          }
          return true
        },
      },
      extension: {
        getViews: () => [
          {
            location: { href: 'moz-extension://id/popup.html' },
            document: { visibilityState: 'visible', hasFocus: () => true },
          },
        ],
      },
    }

    const fakeWindow: Record<string, unknown> = {
      location: { href: 'moz-extension://id/_generated_background_page.html' },
    }
    const fakeNavigator: Record<string, unknown> = {}
    const sandbox: Record<string, unknown> = {
      chrome: chromeMock,
      browser: chromeMock,
      window: fakeWindow,
      navigator: fakeNavigator,
      Promise,
      Object,
      Set,
      queueMicrotask,
    }
    sandbox.globalThis = sandbox
    vm.runInNewContext(buildFirefoxRuntimeShim(), sandbox)

    const sp = chromeMock.sidePanel as {
      open: () => Promise<void>
      setOptions: (o: { path: string; tabId?: number }) => Promise<void>
      getOptions: () => Promise<{ path: string; enabled: boolean }>
    }
    await sp.open()
    expect(openedSidebar).toBe(true)
    await sp.setOptions({ path: 'alt.html', tabId: 3 })
    expect(setPanelArgs).toEqual({ panel: 'alt.html', tabId: 3 })
    expect(await sp.getOptions()).toEqual({ path: 'side.html', enabled: true })

    expect((chromeMock.scripting as { ExecutionWorld: Record<string, string> }).ExecutionWorld).toEqual({
      ISOLATED: 'ISOLATED',
      MAIN: 'MAIN',
    })

    const perms = chromeMock.permissions as { contains: (d: { permissions: string[] }) => Promise<boolean> }
    expect(await perms.contains({ permissions: ['offscreen'] })).toBe(false)
    expect(await perms.contains({ permissions: ['storage'] })).toBe(true)

    const dnr = chromeMock.declarativeNetRequest as { updateDynamicRules: (o: unknown) => Promise<void> }
    await dnr.updateDynamicRules({
      addRules: [{ id: 1, condition: { urlFilter: 'foo', responseHeaders: [{ header: 'csp' }] } }],
    })
    expect(dnrArgs).toEqual({ addRules: [{ id: 1, condition: { urlFilter: 'foo' } }] })

    expect(fakeNavigator.serviceWorker).toBeDefined()

    const clients = sandbox.clients as { matchAll: () => Promise<Array<{ url: string; type: string }>> }
    const matched = await clients.matchAll()
    expect(matched).toHaveLength(1)
    expect(matched[0]?.url).toBe('moz-extension://id/popup.html')
  })

  it('patches Webpack 5 importScripts chunk loader for Firefox Event Page', () => {
    const src = '(()=>{var e={792:1};i.f.i=(t,r)=>{e[t]||importScripts(i.p+i.u(t))};})()'
    const patched = patchWebpackImportScriptsLoader(src)
    expect(patched).toContain('typeof importScripts==="function"')
    expect(patched).toContain('document.createElement("script")')
    expect(patched).toContain('r.push(new Promise(')
  })
})

describe('patchExtensionForFirefox', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'extport-ff-compat-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('wires module service worker into wrapper and injects shim into popup/options/sidebar HTML', async () => {
    await mkdir(path.join(dir, 'js'), { recursive: true })
    await mkdir(path.join(dir, 'pages'), { recursive: true })
    await writeFile(path.join(dir, 'js', 'bg.js'), 'export const ok = true;\n')
    await writeFile(path.join(dir, 'pages', 'popup.html'), '<!doctype html><html><head></head><body></body></html>')
    await writeFile(path.join(dir, 'side.html'), '<!doctype html><html><head></head><body></body></html>')
    await writeFile(
      path.join(dir, 'manifest.json'),
      '\uFEFF' +
        JSON.stringify({
          manifest_version: 3,
          name: 'Mod Ext',
          version: '1.0.0',
          background: { service_worker: 'js/bg.js', type: 'module' },
          action: { default_popup: 'pages/popup.html' },
          side_panel: { default_path: 'side.html' },
        }),
    )

    const res = await patchExtensionForFirefox(dir, { geckoId: 'mod@port.extport.dev', minVersion: '128.0' })
    expect(res.patchedPages).toEqual(['pages/popup.html', 'side.html'])

    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf-8'))
    expect(manifest.background).toEqual({
      scripts: [`js/${COMPAT_FIREFOX_BG_WRAPPER_NAME}`],
      type: 'module',
    })
    const wrapper = await readFile(path.join(dir, 'js', COMPAT_FIREFOX_BG_WRAPPER_NAME), 'utf-8')
    expect(wrapper).toContain(`import "../${COMPAT_FIREFOX_RUNTIME_NAME}";`)
    expect(wrapper).toContain('import "./bg.js";')

    const popup = await readFile(path.join(dir, 'pages', 'popup.html'), 'utf-8')
    expect(popup).toContain(`<script src="../${COMPAT_FIREFOX_RUNTIME_NAME}"></script>`)
    const side = await readFile(path.join(dir, 'side.html'), 'utf-8')
    expect(side).toContain(`<script src="./${COMPAT_FIREFOX_RUNTIME_NAME}"></script>`)
  })
})
