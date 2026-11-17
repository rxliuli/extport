import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithRetry, fetchWithTimeout, storeApiError, submitFailure, type FetchLike } from '../src/util'

describe('storeApiError', () => {
  it('keeps the message shape adapters always used', () => {
    expect(storeApiError('amo unavailable', 503).message).toBe('amo unavailable (503)')
    expect(storeApiError('upload failed', 400, 'bad zip').message).toBe('upload failed (400): bad zip')
  })

  it.each([
    ['ASC / JSON:API', { errors: [{ code: 'UNEXPECTED_ERROR' }] }, 'UNEXPECTED_ERROR'],
    ['Google APIs', { error: { code: 500, status: 'INTERNAL' } }, 'INTERNAL'],
    ['OAuth', { error: 'invalid_grant' }, 'invalid_grant'],
    ['plain code', { code: 'throttled' }, 'throttled'],
    ['no code', { detail: 'Not found.' }, null],
  ])('reads the error code from a %s body', (_name, body, code) => {
    expect(storeApiError('x', 500, JSON.stringify(body)).code).toBe(code)
  })

  it('has no code for a non-JSON body', () => {
    expect(storeApiError('x', 502, '<html>Bad Gateway</html>').code).toBeNull()
  })
})

describe('submitFailure', () => {
  it('is a plain failure carrying the status and code', () => {
    expect(submitFailure('publish failed', 500, JSON.stringify({ error: { status: 'INTERNAL' } }))).toEqual({
      submitted: false,
      detail: 'publish failed (500): {"error":{"status":"INTERNAL"}}',
      status: 500,
      code: 'INTERNAL',
    })
  })
})

// A store that accepts the request and never answers — until it's aborted.
const hangingFetch: FetchLike = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
  })

describe('fetchWithTimeout', () => {
  afterEach(() => vi.restoreAllMocks())

  it('turns a request that never answers into a named error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = fetchWithTimeout(hangingFetch, 'safari', 20)
    await expect(fetch('https://api.appstoreconnect.apple.com/v1/apps/1/appStoreVersions?limit=10')).rejects.toThrow(
      'safari request timed out after 0s: GET /v1/apps/1/appStoreVersions',
    )
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ message: 'store request timed out', store: 'safari' })
  })

  it('is per attempt under fetchWithRetry, and a timeout is not retried', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const counting: FetchLike = (i, o) => {
      calls++
      return hangingFetch(i, o)
    }
    const fetch = fetchWithRetry(fetchWithTimeout(counting, 'safari', 20), { attempts: 3, baseDelayMs: 1 })
    await expect(fetch('https://x.test/a')).rejects.toThrow(/timed out/)
    expect(calls).toBe(1)
  })

  it('passes other failures through untouched', async () => {
    const boom = new TypeError('network down')
    const fetch = fetchWithTimeout(() => Promise.reject(boom), 'chrome', 1_000)
    await expect(fetch('https://x.test/a')).rejects.toBe(boom)
  })

  it('logs a slow call with its duration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(0).mockReturnValueOnce(12_345)
    const fetch = fetchWithTimeout(() => Promise.resolve(new Response('', { status: 200 })), 'edge', 60_000)
    await fetch('https://api.addons.microsoftedge.microsoft.com/v1/products/p/submissions', { method: 'POST' })
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
      level: 'warn',
      message: 'slow store request',
      store: 'edge',
      method: 'POST',
      path: '/v1/products/p/submissions',
      status: 200,
      ms: 12_345,
    })
  })
})
