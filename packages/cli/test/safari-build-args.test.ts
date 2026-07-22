import { describe, expect, it } from 'vitest'
import { parseSafariBuildArgs } from '../src/safari-build-args.js'

const env = { ASC_ISSUER_ID: 'iss-1', ASC_KEY_ID: 'KEY1' }

describe('parseSafariBuildArgs', () => {
  it('parses a full invocation with defaults', () => {
    const options = parseSafariBuildArgs(['--project-path', './ios', '--team-id', 'TEAM1'], env)
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

  it('prefers flags over env for the ASC credentials', () => {
    const options = parseSafariBuildArgs(
      ['--project-path', './ios', '--team-id', 'TEAM1', '--issuer-id', 'iss-2', '--key-id', 'KEY2', '--key-path', '/tmp/k.p8'],
      env,
    )
    expect(options).toMatchObject({ issuerId: 'iss-2', keyId: 'KEY2', keyPath: '/tmp/k.p8' })
  })

  it('requires project-path and team-id', () => {
    expect(() => parseSafariBuildArgs(['--team-id', 'T'], env)).toThrow(/--project-path/)
    expect(() => parseSafariBuildArgs(['--project-path', 'p'], env)).toThrow(/--team-id/)
  })

  it('requires the ASC issuer and key id from flags or env', () => {
    expect(() => parseSafariBuildArgs(['--project-path', 'p', '--team-id', 'T'], {})).toThrow(/issuer id/)
    expect(() => parseSafariBuildArgs(['--project-path', 'p', '--team-id', 'T', '--issuer-id', 'i'], {})).toThrow(/key id/)
  })

  it('validates --version and --platform', () => {
    expect(() => parseSafariBuildArgs(['--project-path', 'p', '--team-id', 'T', '--version', 'v1'], env)).toThrow(/--version/)
    expect(() => parseSafariBuildArgs(['--project-path', 'p', '--team-id', 'T', '--platform', 'watchos'], env)).toThrow(/--platform must be/)
    const options = parseSafariBuildArgs(['--project-path', 'p', '--team-id', 'T', '--version', '1.2.3', '--platform', 'ios'], env)
    expect(options).toMatchObject({ version: '1.2.3', platform: 'ios' })
  })

  it('accepts a custom macOS deployment target', () => {
    const options = parseSafariBuildArgs(['--project-path', 'p', '--team-id', 'T', '--macos-deployment-target', '13.0'], env)
    expect(options.macosDeploymentTarget).toBe('13.0')
  })

  it('rejects dangling flags and non-flag arguments', () => {
    expect(() => parseSafariBuildArgs(['--project-path'], env)).toThrow(/requires a value/)
    expect(() => parseSafariBuildArgs(['stray'], env)).toThrow(/unexpected argument/)
  })

  it('falls back to defaults (extport.config.json) when a flag is absent', () => {
    const options = parseSafariBuildArgs([], env, { projectPath: './ios', teamId: 'TEAM1', issuerId: 'iss-default', keyId: 'KEY-default' })
    expect(options).toMatchObject({ projectPath: './ios', teamId: 'TEAM1' })
    // env still wins over defaults for issuer/key id.
    expect(options.issuerId).toBe('iss-1')
    expect(options.keyId).toBe('KEY1')
  })

  it('flags beat both env and defaults', () => {
    const options = parseSafariBuildArgs(
      ['--project-path', './flag-path', '--team-id', 'FLAG-TEAM'],
      env,
      { projectPath: './default-path', teamId: 'DEFAULT-TEAM' },
    )
    expect(options.projectPath).toBe('./flag-path')
    expect(options.teamId).toBe('FLAG-TEAM')
  })
})
