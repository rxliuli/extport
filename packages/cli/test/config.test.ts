import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearGlobalConfig, loadGlobalConfig, loadProjectConfig, saveGlobalConfig, saveProjectConfig } from '../src/config.js'

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
