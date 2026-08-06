import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateProjectConfig, loadProjectConfig, saveProjectConfig } from '../src/project-config'

describe('generateProjectConfig', () => {
  it('produces the full file from authored values in one pass', () => {
    const { config, changed } = generateProjectConfig(
      {},
      { extension: 'ext_a', safari: { projectPath: '.output/My Ext', teamId: 'TEAM1', issuerId: 'iss-1', keyId: 'KEY1' } },
    )
    expect(config).toEqual({
      extension: 'ext_a',
      safari: { projectPath: '.output/My Ext', teamId: 'TEAM1', issuerId: 'iss-1', keyId: 'KEY1' },
    })
    expect(changed).toBe(true)
  })

  it('reports unchanged when regeneration produces the same file', () => {
    const existing = { extension: 'ext_a', safari: { projectPath: '.output/My Ext', teamId: 'TEAM1' } }
    const { changed } = generateProjectConfig(existing, {
      extension: 'ext_a',
      safari: { projectPath: '.output/My Ext', teamId: 'TEAM1' },
    })
    expect(changed).toBe(false)
  })

  it('unauthored fields never clobber existing values (CLI-written history survives)', () => {
    const existing = { apiUrl: 'https://api.extport.dev', safari: { issuerId: 'iss-cli', keyId: 'KEY-cli', teamId: 'TEAM1' } }
    const { config } = generateProjectConfig(existing, { extension: 'ext_a', safari: { projectPath: '.output/X' } })
    expect(config).toEqual({
      apiUrl: 'https://api.extport.dev',
      extension: 'ext_a',
      safari: { issuerId: 'iss-cli', keyId: 'KEY-cli', teamId: 'TEAM1', projectPath: '.output/X' },
    })
  })

  it('authored values win over stale file values', () => {
    const existing = { extension: 'ext_old', safari: { teamId: 'OLD', issuerId: 'iss-old' } }
    const { config, changed } = generateProjectConfig(existing, {
      extension: 'ext_new',
      safari: { teamId: 'NEW', issuerId: 'iss-new', projectPath: '.output/X' },
    })
    expect(config.extension).toBe('ext_new')
    expect(config.safari).toMatchObject({ teamId: 'NEW', issuerId: 'iss-new' })
    expect(changed).toBe(true)
  })

  it('an extension-only project does not grow a safari block', () => {
    const { config } = generateProjectConfig({}, { extension: 'ext_a' })
    expect(config).toEqual({ extension: 'ext_a' })
  })

  // Regression: a chrome run must not overwrite the projectPath a safari run
  // recorded. Extensions that rename themselves for Safari resolve a
  // different manifest.name on chrome, and writing that would point
  // `extport safari-build` at a directory the converter never creates.
  it('a non-safari run leaves an existing projectPath intact', () => {
    const existing = { extension: 'ext_a', safari: { projectPath: '.output/Clean for Twitter', teamId: 'TEAM1' } }
    const { config, changed } = generateProjectConfig(existing, {
      extension: 'ext_a',
      safari: { teamId: 'TEAM1' },
    })
    expect(config.safari?.projectPath).toBe('.output/Clean for Twitter')
    expect(changed).toBe(false)
  })
})

describe('loadProjectConfig / saveProjectConfig', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'extport-wxt-test-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('returns an empty object when extport.config.json does not exist', async () => {
    expect(await loadProjectConfig(cwd)).toEqual({})
  })

  it('round-trips through save and load', async () => {
    await saveProjectConfig({ extension: 'my-ext', safari: { projectPath: '.output/My Ext', teamId: 'TEAM1' } }, cwd)
    expect(await loadProjectConfig(cwd)).toEqual({ extension: 'my-ext', safari: { projectPath: '.output/My Ext', teamId: 'TEAM1' } })
  })
})
