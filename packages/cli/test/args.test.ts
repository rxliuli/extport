import { describe, expect, it } from 'vitest'
import { buildPushUrl, parsePushArgs } from '../src/args.mjs'

const env = { EXTPORT_API_KEY: 'sk_live_' + 'a'.repeat(40) }

describe('parsePushArgs', () => {
  it('parses a full invocation', () => {
    const options = parsePushArgs(
      ['dist.zip', '--extension', 'my-ext', '--version', '1.2.3', '--store', 'chrome'],
      env,
    )
    expect(options).toMatchObject({
      file: 'dist.zip',
      extension: 'my-ext',
      version: '1.2.3',
      store: 'chrome',
      apiUrl: 'https://dash.extport.dev',
    })
  })

  it('prefers flags over env for key and url', () => {
    const options = parsePushArgs(
      ['d.zip', '--extension', 'e', '--version', '1', '--api-key', 'sk_live_x', '--api-url', 'http://localhost:8787/'],
      env,
    )
    expect(options.apiKey).toBe('sk_live_x')
    expect(options.apiUrl).toBe('http://localhost:8787')
  })

  it('requires extension, version, api key, and file', () => {
    expect(() => parsePushArgs(['--extension', 'e', '--version', '1'], env)).toThrow(/zip file/)
    expect(() => parsePushArgs(['d.zip', '--version', '1'], env)).toThrow(/--extension/)
    expect(() => parsePushArgs(['d.zip', '--extension', 'e'], env)).toThrow(/--version/)
    expect(() => parsePushArgs(['d.zip', '--extension', 'e', '--version', 'v1'], env)).toThrow(/--version/)
    expect(() => parsePushArgs(['d.zip', '--extension', 'e', '--version', '1'], {})).toThrow(/API key/)
  })

  it('rejects unknown stores and dangling flags', () => {
    expect(() =>
      parsePushArgs(['d.zip', '--extension', 'e', '--version', '1', '--store', 'opera'], env),
    ).toThrow(/--store must be/)
    expect(() => parsePushArgs(['d.zip', '--extension'], env)).toThrow(/requires a value/)
  })
})

describe('buildPushUrl', () => {
  it('builds the artifacts endpoint with query params', () => {
    const url = buildPushUrl({
      file: 'd.zip',
      extension: 'my-ext',
      version: '1.2.3',
      store: 'firefox',
      apiUrl: 'https://api.example.com',
      apiKey: 'k',
    })
    expect(url).toBe('https://api.example.com/api/v1/artifacts?extension=my-ext&version=1.2.3&store=firefox')
  })
})
