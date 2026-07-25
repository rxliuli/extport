import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadProjectConfig, saveProjectConfig, syncSafariConfig } from '../src/project-config'

describe('syncSafariConfig', () => {
  it('sets projectPath and reports changed when nothing existed before', () => {
    const { config, changed } = syncSafariConfig({}, { projectPath: '.output/My Ext' })
    expect(config.safari?.projectPath).toBe('.output/My Ext')
    expect(changed).toBe(true)
  })

  it('reports unchanged when the same projectPath is synced again', () => {
    const existing = { safari: { projectPath: '.output/My Ext' } }
    const { changed } = syncSafariConfig(existing, { projectPath: '.output/My Ext' })
    expect(changed).toBe(false)
  })

  it('does not clobber teamId when developmentTeam is not configured', () => {
    const existing = { safari: { projectPath: '.output/My Ext', teamId: 'TEAM1' } }
    const { config, changed } = syncSafariConfig(existing, { projectPath: '.output/My Ext' })
    expect(config.safari?.teamId).toBe('TEAM1')
    expect(changed).toBe(false)
  })

  it('updates teamId when developmentTeam is configured and differs', () => {
    const existing = { safari: { projectPath: '.output/My Ext', teamId: 'OLD' } }
    const { config, changed } = syncSafariConfig(existing, { projectPath: '.output/My Ext', teamId: 'NEW' })
    expect(config.safari?.teamId).toBe('NEW')
    expect(changed).toBe(true)
  })

  it('preserves unrelated fields (extension, apiUrl, issuerId, keyId)', () => {
    const existing = { extension: 'my-ext', apiUrl: 'https://api.extport.dev', safari: { issuerId: 'iss-1', keyId: 'KEY1' } }
    const { config } = syncSafariConfig(existing, { projectPath: '.output/My Ext' })
    expect(config).toMatchObject({
      extension: 'my-ext',
      apiUrl: 'https://api.extport.dev',
      safari: { issuerId: 'iss-1', keyId: 'KEY1', projectPath: '.output/My Ext' },
    })
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
