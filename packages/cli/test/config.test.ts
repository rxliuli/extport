import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearGlobalConfig,
  loadGlobalConfig,
  loadProjectConfig,
  normalizeApiUrl,
  parseApiUrl,
  resolveApiUrl,
  resolveCredentials,
  resolveStoredApiKey,
  sameApiOrigin,
  saveGlobalConfig,
  saveProjectConfig,
  warnIfProjectApiUrl,
} from '../src/config'

describe('global config (extport login state)', () => {
  let home: string
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true })
  })

  it('returns {} when nothing has been saved yet', async () => {
    home = await mkdtemp(join(tmpdir(), 'extport-config-test-'))
    expect(await loadGlobalConfig(home)).toEqual({})
  })

  it('round-trips apiKey/apiUrl and restricts the file to owner-only', async () => {
    home = await mkdtemp(join(tmpdir(), 'extport-config-test-'))
    await saveGlobalConfig({ apiKey: 'sk_live_x', apiUrl: 'https://dash.extport.dev' }, home)
    expect(await loadGlobalConfig(home)).toEqual({ apiKey: 'sk_live_x', apiUrl: 'https://dash.extport.dev' })

    const info = await stat(join(home, '.config', 'extport', 'config.json'))
    // 0o600 — the only thing on disk holding the key in plaintext.
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('creates ~/.config/extport if it does not exist yet', async () => {
    home = await mkdtemp(join(tmpdir(), 'extport-config-test-'))
    await saveGlobalConfig({ apiKey: 'sk_live_x' }, home)
    expect(await readFile(join(home, '.config', 'extport', 'config.json'), 'utf8')).toContain('sk_live_x')
  })

  it('clearGlobalConfig removes the file, and is a no-op if it never existed', async () => {
    home = await mkdtemp(join(tmpdir(), 'extport-config-test-'))
    await saveGlobalConfig({ apiKey: 'sk_live_x' }, home)
    await clearGlobalConfig(home)
    expect(await loadGlobalConfig(home)).toEqual({})
    await expect(clearGlobalConfig(home)).resolves.toBeUndefined()
  })
})

describe('project config (extport.config.json)', () => {
  let cwd: string
  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true })
  })

  it('returns {} when the file does not exist', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'extport-project-config-test-'))
    expect(await loadProjectConfig(cwd)).toEqual({})
  })

  it('round-trips extension and the safari block', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'extport-project-config-test-'))
    const config = { extension: 'scrub', safari: { projectPath: './ios', teamId: 'TEAM1', issuerId: 'iss-1', keyId: 'KEY1' } }
    await saveProjectConfig(config, cwd)
    expect(await loadProjectConfig(cwd)).toEqual(config)
  })

  it('is plain, readable JSON meant to be checked into the repo — no restrictive file mode', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'extport-project-config-test-'))
    await saveProjectConfig({ extension: 'scrub' }, cwd)
    const info = await stat(join(cwd, 'extport.config.json'))
    expect(info.mode & 0o777).not.toBe(0o600)
  })
})

describe('API URL validation and origin-bound credentials', () => {
  it('accepts http/https URLs and rejects other schemes, credentials, or malformed URLs', () => {
    expect(normalizeApiUrl('https://dash.extport.dev/')).toBe('https://dash.extport.dev')
    expect(normalizeApiUrl('http://127.0.0.1:8787///')).toBe('http://127.0.0.1:8787')
    expect(() => parseApiUrl('file:///etc/passwd')).toThrow(/http:\/\/ or https:\/\//)
    expect(() => parseApiUrl('javascript:alert(1)')).toThrow(/http:\/\/ or https:\/\//)
    expect(() => parseApiUrl('https://user:pass@dash.extport.dev')).toThrow(/credentials in URL/)
    expect(() => parseApiUrl('not-a-url')).toThrow(/invalid API URL/)
  })

  it('compares origins accurately across default ports, trailing slashes, and ports', () => {
    expect(sameApiOrigin('https://dash.extport.dev', 'https://DASH.EXTPORT.DEV:443/')).toBe(true)
    expect(sameApiOrigin('http://127.0.0.1:8788', 'http://127.0.0.1:8787')).toBe(false)
    expect(sameApiOrigin('https://dash.extport.dev', 'http://dash.extport.dev')).toBe(false)
    expect(sameApiOrigin('https://dash.extport.dev', 'https://evil.example')).toBe(false)
  })

  it('resolves apiUrl from flag > env > global config > default', () => {
    expect(resolveApiUrl({})).toBe('https://dash.extport.dev')
    expect(resolveApiUrl({ env: { EXTPORT_API_URL: '' }, globalConfig: { apiUrl: 'http://127.0.0.1:8788/' } })).toBe('http://127.0.0.1:8788')
    expect(resolveApiUrl({ globalConfig: { apiUrl: 'http://127.0.0.1:8788/' } })).toBe('http://127.0.0.1:8788')
    expect(resolveApiUrl({ env: { EXTPORT_API_URL: 'http://127.0.0.1:9000/' }, globalConfig: { apiUrl: 'http://127.0.0.1:8788' } })).toBe(
      'http://127.0.0.1:9000',
    )
    expect(
      resolveApiUrl({
        flagApiUrl: 'https://staging.extport.dev/',
        env: { EXTPORT_API_URL: 'http://127.0.0.1:9000' },
        globalConfig: { apiUrl: 'http://127.0.0.1:8788' },
      }),
    ).toBe('https://staging.extport.dev')
  })

  it('only sends stored global apiKey to the origin it was issued for', () => {
    const globalConfig = { apiKey: 'sk_live_prod', apiUrl: 'https://dash.extport.dev' }
    expect(resolveStoredApiKey(globalConfig, 'https://dash.extport.dev/')).toBe('sk_live_prod')
    expect(resolveStoredApiKey(globalConfig, 'https://dash.extport.dev:443')).toBe('sk_live_prod')
    expect(resolveStoredApiKey(globalConfig, 'http://127.0.0.1:8787')).toBeUndefined()
    expect(resolveStoredApiKey({ apiKey: 'sk_live_legacy' }, 'https://dash.extport.dev')).toBe('sk_live_legacy')
    expect(resolveStoredApiKey({ apiKey: 'sk_live_legacy' }, 'http://127.0.0.1:8787')).toBeUndefined()
  })

  it('resolveCredentials rejects mismatched target origin unless an explicit key is supplied', () => {
    const globalConfig = { apiKey: 'sk_live_prod', apiUrl: 'https://dash.extport.dev' }
    expect(resolveCredentials({ globalConfig })).toEqual({ apiUrl: 'https://dash.extport.dev', apiKey: 'sk_live_prod' })

    expect(() => resolveCredentials({ flagApiUrl: 'http://127.0.0.1:8787', globalConfig })).toThrow(/stored credentials belong to https:\/\/dash\.extport\.dev/)
    expect(() => resolveCredentials({ env: { EXTPORT_API_URL: 'http://127.0.0.1:8787' }, globalConfig })).toThrow(
      /not logged in for http:\/\/127\.0\.0\.1:8787/,
    )
    expect(resolveCredentials({ flagApiUrl: 'http://127.0.0.1:8787', flagApiKey: 'sk_live_local', globalConfig })).toEqual({
      apiUrl: 'http://127.0.0.1:8787',
      apiKey: 'sk_live_local',
    })
    expect(() => resolveCredentials({ globalConfig: {} })).toThrow(/not logged in — run 'extport login'/)
  })

  it('warns when extport.config.json contains an ignored apiUrl', () => {
    const warn = vi.fn()
    expect(warnIfProjectApiUrl({ extension: 'ext_1' }, warn)).toBe(false)
    expect(warn).not.toHaveBeenCalled()

    expect(warnIfProjectApiUrl({ extension: 'ext_1', apiUrl: 'http://127.0.0.1:8787' }, warn)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring "apiUrl" in extport.config.json'))
  })
})
