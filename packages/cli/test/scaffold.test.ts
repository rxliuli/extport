import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createExtension, patchScaffold, slugify } from '../src/scaffold'

describe('slugify', () => {
  it('matches the fleet gecko-id convention', () => {
    expect(slugify('Gemini Exporter')).toBe('gemini-exporter')
    expect(slugify('Scrub - Clear Site Data')).toBe('scrub-clear-site-data')
    expect(slugify('  My  Extension!! ')).toBe('my-extension')
  })

  it('degenerates to empty for fully non-ASCII names (the prompt fallback case)', () => {
    expect(slugify('沉浸式翻译')).toBe('')
  })
})

describe('patchScaffold', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'extport-scaffold-'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'browser-extension-template', version: '0.0.0' }, null, 2))
    await writeFile(
      join(dir, 'wxt.config.ts'),
      [
        "  extport: {",
        "    extension: 'ext_YOUR_EXTENSION_ID',",
        "  },",
        "      name: 'Browser Extension Template',",
        "      homepage_url: 'https://rxliuli.com/project/browser-extension-template',",
      ].join('\n'),
    )
    await writeFile(join(dir, 'README.md'), '# Browser Extension Template\n\nClone browser-extension-template to start.\n')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('wires id, display name, and slug into the template literals', async () => {
    await patchScaffold(dir, { extensionId: 'ext_abc123', name: 'Gemini Exporter', slug: 'gemini-exporter' })

    const packageJson = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name: string; version: string }
    expect(packageJson.name).toBe('gemini-exporter')
    expect(packageJson.version).toBe('0.0.0')

    const wxtConfig = await readFile(join(dir, 'wxt.config.ts'), 'utf8')
    expect(wxtConfig).toContain("extension: 'ext_abc123'")
    expect(wxtConfig).toContain("name: 'Gemini Exporter'")
    expect(wxtConfig).toContain('https://rxliuli.com/project/gemini-exporter')
    expect(wxtConfig).not.toContain('YOUR_EXTENSION_ID')

    const readme = await readFile(join(dir, 'README.md'), 'utf8')
    expect(readme).toContain('# Gemini Exporter')
    expect(readme).not.toContain('browser-extension-template')
  })

  it('survives a template without a README', async () => {
    await rm(join(dir, 'README.md'))
    await expect(patchScaffold(dir, { extensionId: 'ext_a', name: 'X', slug: 'x' })).resolves.toBeUndefined()
  })
})

describe('createExtension', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the created record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ extension: { id: 'ext_new', name: 'My Ext' } }), { status: 201 })),
    )
    await expect(createExtension('https://dash.example.test', 'sk_x', 'My Ext')).resolves.toEqual({ id: 'ext_new', name: 'My Ext' })
  })

  it('surfaces the API error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'name already in use' }), { status: 409 })))
    await expect(createExtension('https://dash.example.test', 'sk_x', 'Dup')).rejects.toThrow('name already in use')
  })
})
