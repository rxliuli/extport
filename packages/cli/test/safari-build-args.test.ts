import { describe, expect, it } from 'vitest'
import { resolveSafariBuildOptions } from '../src/safari-build-args.js'

const env = { ASC_ISSUER_ID: 'iss-1', ASC_KEY_ID: 'KEY1' }
const base = { macosDeploymentTarget: '12.0' }

describe('resolveSafariBuildOptions', () => {
  it('resolves a full invocation with defaults', () => {
    const options = resolveSafariBuildOptions({ ...base, projectPath: './ios', teamId: 'TEAM1' }, env)
    expect(options).toEqual({
      projectPath: './ios',
      teamId: 'TEAM1',
      issuerId: 'iss-1',
      keyId: 'KEY1',
      keyPath: undefined,
      version: undefined,
      platform: undefined,
      macosDeploymentTarget: '12.0',
    })
  })

  it('prefers raw flags over env for the ASC credentials', () => {
    const options = resolveSafariBuildOptions(
      { ...base, projectPath: './ios', teamId: 'TEAM1', issuerId: 'iss-2', keyId: 'KEY2', keyPath: '/tmp/k.p8' },
      env,
    )
    expect(options).toMatchObject({ issuerId: 'iss-2', keyId: 'KEY2', keyPath: '/tmp/k.p8' })
  })

  it('requires project-path and team-id', () => {
    expect(() => resolveSafariBuildOptions({ ...base, teamId: 'T' }, env)).toThrow(/--project-path/)
    expect(() => resolveSafariBuildOptions({ ...base, projectPath: 'p' }, env)).toThrow(/--team-id/)
  })

  it('requires the ASC issuer and key id from raw flags or env', () => {
    expect(() => resolveSafariBuildOptions({ ...base, projectPath: 'p', teamId: 'T' }, {})).toThrow(/issuer id/)
    expect(() => resolveSafariBuildOptions({ ...base, projectPath: 'p', teamId: 'T', issuerId: 'i' }, {})).toThrow(/key id/)
  })

  it('validates --version format', () => {
    expect(() => resolveSafariBuildOptions({ ...base, projectPath: 'p', teamId: 'T', version: 'v1' }, env)).toThrow(/--version/)
    const options = resolveSafariBuildOptions({ ...base, projectPath: 'p', teamId: 'T', version: '1.2.3', platform: 'ios' }, env)
    expect(options).toMatchObject({ version: '1.2.3', platform: 'ios' })
  })

  it('accepts a custom macOS deployment target', () => {
    const options = resolveSafariBuildOptions({ macosDeploymentTarget: '13.0', projectPath: 'p', teamId: 'T' }, env)
    expect(options.macosDeploymentTarget).toBe('13.0')
  })

  it('falls back to defaults (extport.config.json) when a raw flag is absent', () => {
    const options = resolveSafariBuildOptions({ ...base }, env, { projectPath: './ios', teamId: 'TEAM1', issuerId: 'iss-default', keyId: 'KEY-default' })
    expect(options).toMatchObject({ projectPath: './ios', teamId: 'TEAM1' })
    // env still wins over defaults for issuer/key id.
    expect(options.issuerId).toBe('iss-1')
    expect(options.keyId).toBe('KEY1')
  })

  it('raw flags beat both env and defaults', () => {
    const options = resolveSafariBuildOptions(
      { ...base, projectPath: './flag-path', teamId: 'FLAG-TEAM' },
      env,
      { projectPath: './default-path', teamId: 'DEFAULT-TEAM' },
    )
    expect(options.projectPath).toBe('./flag-path')
    expect(options.teamId).toBe('FLAG-TEAM')
  })
})
