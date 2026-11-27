import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMPAT_STYLESHEET_NAME,
  buildSafariCompatCss,
  collectExtensionHtmlPages,
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
})
