import { describe, expect, it } from 'vitest'
import { buildPushUrl, resolvePushOptions } from '../src/args.js'

const env = { EXTPORT_API_KEY: 'sk_live_' + 'a'.repeat(40) }

describe('resolvePushOptions', () => {
  it('resolves a full invocation', () => {
    const options = resolvePushOptions({ file: 'dist.zip', extension: 'my-ext', version: '1.2.3', store: 'chrome' }, env)
    expect(options).toMatchObject({ file: 'dist.zip', extension: 'my-ext', version: '1.2.3', store: 'chrome', apiUrl: 'https://dash.extport.dev' })
  })

  it('prefers raw flags over env for key and url, and strips a trailing slash from the url', () => {
    const options = resolvePushOptions({ file: 'd.zip', extension: 'e', version: '1', apiKey: 'sk_live_x', apiUrl: 'http://localhost:8787/' }, env)
    expect(options.apiKey).toBe('sk_live_x')
    expect(options.apiUrl).toBe('http://localhost:8787')
  })

  it('requires a file for every store other than safari', () => {
    expect(() => resolvePushOptions({ extension: 'e', version: '1', store: 'chrome' }, env)).toThrow(/zip file/)
    expect(() => resolvePushOptions({ extension: 'e', version: '1' }, env)).toThrow(/zip file/)
  })

  it('allows --store safari with no file — the binary already reached ASC out-of-band', () => {
    const options = resolvePushOptions({ extension: 'e', version: '1', store: 'safari' }, env)
    expect(options.file).toBeUndefined()
    expect(options.store).toBe('safari')
  })

  it('requires extension, version (1-4 dot-separated integers), and an api key', () => {
    expect(() => resolvePushOptions({ file: 'd.zip', version: '1' }, env)).toThrow(/--extension/)
    expect(() => resolvePushOptions({ file: 'd.zip', extension: 'e' }, env)).toThrow(/--version/)
    expect(() => resolvePushOptions({ file: 'd.zip', extension: 'e', version: 'v1' }, env)).toThrow(/--version/)
    expect(() => resolvePushOptions({ file: 'd.zip', extension: 'e', version: '1' }, {})).toThrow(/API key/)
  })

  it('accepts --source-zip only alongside --store firefox', () => {
    const options = resolvePushOptions({ file: 'd.zip', extension: 'e', version: '1', store: 'firefox', sourceZip: 'src.zip' }, env)
    expect(options.sourceZip).toBe('src.zip')

    expect(() => resolvePushOptions({ file: 'd.zip', extension: 'e', version: '1', store: 'chrome', sourceZip: 'src.zip' }, env)).toThrow(
      /--source-zip is only valid with --store firefox/,
    )
    expect(() => resolvePushOptions({ file: 'd.zip', extension: 'e', version: '1', sourceZip: 'src.zip' }, env)).toThrow(
      /--source-zip is only valid with --store firefox/,
    )
  })

  it('falls back to defaults (project config / extport login) when a flag and env are both absent', () => {
    const options = resolvePushOptions({ file: 'd.zip', version: '1' }, {}, { extension: 'scrub', apiKey: 'sk_live_from_login', apiUrl: 'https://dash.extport.dev/' })
    expect(options).toMatchObject({ extension: 'scrub', apiKey: 'sk_live_from_login', apiUrl: 'https://dash.extport.dev' })
  })

  it('raw flags beat env, and env beats defaults', () => {
    const options = resolvePushOptions(
      { file: 'd.zip', version: '1', extension: 'flag-ext' },
      { EXTPORT_API_KEY: 'sk_live_env' },
      { extension: 'default-ext', apiKey: 'sk_live_default' },
    )
    expect(options.extension).toBe('flag-ext')
    expect(options.apiKey).toBe('sk_live_env')
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
