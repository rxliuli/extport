import { describe, expect, it } from 'vitest'
import { createFirefoxAdapter } from '../src/firefox'
import { queueFetch } from './fetch-stub'

const creds = { jwtIssuer: 'user:1:23', jwtSecret: 'amosecret' }
const ADDON = 'my-addon'
// Real (tiny) intervals instead of vitest fake timers — WebCrypto's async
// completion isn't driven by the fake clock, so fake-timer polling tests hang.
const FAST_POLL = { intervalMs: 1, attempts: 3 }

describe('firefox adapter — getState', () => {
  it('reports live-only when nothing newer has been submitted', async () => {
    const { fetch } = queueFetch([
      { status: 200, body: { current_version: { version: '1.0.0' } } },
      { status: 200, body: { results: [{ version: '1.0.0', file: { status: 'public' } }] } },
    ])
    const state = await createFirefoxAdapter(fetch).getState(creds, { storeItemId: ADDON })
    expect(state).toEqual({ live: { known: true, version: '1.0.0' }, inReview: { known: true } })
  })

  it('reports a pending (unreviewed) newer version', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { current_version: { version: '1.0.0' } } },
      { status: 200, body: { results: [{ version: '1.1.0', file: { status: 'unreviewed' } }] } },
    ])
    const state = await createFirefoxAdapter(fetch).getState(creds, { storeItemId: ADDON })
    expect(state).toEqual({ live: { known: true, version: '1.0.0' }, inReview: { known: true, version: '1.1.0' }, reviewStatus: 'pending' })
    expect(calls[0]!.url).toBe(`https://addons.mozilla.org/api/v5/addons/addon/${ADDON}/`)
    const auth = (calls[0]!.init?.headers as Record<string, string>).authorization
    expect(auth).toMatch(/^JWT [\w-]+\.[\w-]+\.[\w-]+$/)
  })

  it('reports a disabled/rejected newer version, best-effort', async () => {
    const { fetch } = queueFetch([
      { status: 200, body: { current_version: { version: '1.0.0' } } },
      { status: 200, body: { results: [{ version: '1.1.0', file: { status: 'disabled' } }] } },
    ])
    const state = await createFirefoxAdapter(fetch).getState(creds, { storeItemId: ADDON })
    expect(state.inReview).toEqual({ known: true })
    expect(state.reviewStatus).toBe('rejected')
    expect(state.rejectionReason).toMatch(/disabled\/rejected/)
  })
})

describe('firefox adapter — submit', () => {
  it('treats a 429 on upload as backpressure (waiting), surfacing the AMO message', async () => {
    const { fetch } = queueFetch([
      { status: 429, body: { detail: 'Request was throttled. Expected available in 23 seconds.' } },
    ])
    const result = await createFirefoxAdapter(fetch).submit(creds, { storeItemId: ADDON }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(result.waiting).toBe(true)
    expect(result.detail).toMatch(/rate limited during upload/)
    expect(result.detail).toMatch(/about 23 seconds/)
  })

  it('treats a 429 on version creation as backpressure too — the whole submit retries next tick', async () => {
    const { fetch } = queueFetch([
      { status: 200, body: { uuid: 'u1' } },
      { status: 200, body: { processed: true, valid: true } },
      { status: 429, body: { detail: 'Request was throttled. Expected available in 15013 seconds.' } },
    ])
    const result = await createFirefoxAdapter(fetch).submit(creds, { storeItemId: ADDON }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(result.waiting).toBe(true)
    expect(result.detail).toMatch(/rate limited during version creation/)
    // 15013 raw seconds is the daily quota talking — translated for humans.
    expect(result.detail).toMatch(/about 4\.2 hours/)
  })

  it('uploads and attaches a version when validation finishes immediately', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { uuid: 'u1' } },
      { status: 200, body: { processed: true, valid: true } },
      { status: 201, body: {} },
    ])
    const result = await createFirefoxAdapter(fetch).submit(creds, { storeItemId: ADDON }, new ArrayBuffer(8), '1.0.0')
    expect(result).toEqual({ submitted: true })
    expect(calls[0]!.url).toBe('https://addons.mozilla.org/api/v5/addons/upload/')
    expect(calls[2]!.url).toBe(`https://addons.mozilla.org/api/v5/addons/addon/${ADDON}/versions/`)
    const versionBody = calls[2]!.init?.body as FormData
    expect(versionBody.get('upload')).toBe('u1')
    // No source zip was given — AMO gets an empty source field, not a missing one.
    expect(versionBody.get('source')).toBe('')
  })

  it('attaches a source zip when the tenant provided one — AMO requires it for bundled/minified submissions', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { uuid: 'u1' } },
      { status: 200, body: { processed: true, valid: true } },
      { status: 201, body: {} },
    ])
    const sourceZip = new ArrayBuffer(16)
    const result = await createFirefoxAdapter(fetch).submit(creds, { storeItemId: ADDON }, new ArrayBuffer(8), '1.0.0', undefined, sourceZip)
    expect(result).toEqual({ submitted: true })
    const versionBody = calls[2]!.init?.body as FormData
    expect(versionBody.get('upload')).toBe('u1')
    const source = versionBody.get('source') as File
    expect(source.size).toBe(16)
    // Regression: omitting the filename here left the multipart part with no
    // filename= in its Content-Disposition, and a real AMO submission read
    // that as "not an archive" rather than as "a source zip" (caught via a
    // real end-to-end push, not by this test — it only checked size before).
    expect(source.name).toBe('source.zip')
  })

  it('polls a few times before validation completes', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { uuid: 'u1' } },
      { status: 200, body: { processed: false } },
      { status: 200, body: { processed: false } },
      { status: 200, body: { processed: true, valid: true } },
      { status: 201, body: {} },
    ])
    const result = await createFirefoxAdapter(fetch, FAST_POLL).submit(creds, { storeItemId: ADDON }, new ArrayBuffer(8), '1.0.0')
    expect(result).toEqual({ submitted: true })
    expect(calls).toHaveLength(5)
  })

  it('gives up politely (not a failure) if validation is still pending after the poll window', async () => {
    const entries = [
      { status: 200, body: { uuid: 'u1' } },
      ...Array.from({ length: FAST_POLL.attempts }, () => ({ status: 200, body: { processed: false } })),
    ]
    const { fetch, calls } = queueFetch(entries)
    const result = await createFirefoxAdapter(fetch, FAST_POLL).submit(creds, { storeItemId: ADDON }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(true)
    expect(result.detail).toMatch(/still validating/)
    // upload + FAST_POLL.attempts polls, no version-create call
    expect(calls).toHaveLength(1 + FAST_POLL.attempts)
  })

  it('reports invalid uploads as a real failure, without creating a version', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { uuid: 'u1' } },
      { status: 200, body: { processed: true, valid: false, validation: { messages: ['bad manifest'] } } },
    ])
    const result = await createFirefoxAdapter(fetch).submit(creds, { storeItemId: ADDON }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(result.detail).toContain('bad manifest')
    expect(calls).toHaveLength(2)
  })

  it('reports a rejected upload immediately', async () => {
    const { fetch } = queueFetch([{ status: 400, body: 'invalid zip' }])
    const result = await createFirefoxAdapter(fetch).submit(creds, { storeItemId: ADDON }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(result.detail).toContain('invalid zip')
  })
})

describe('firefox adapter — no withdraw capability', () => {
  it('does not implement withdraw (review is automated/near-instant)', () => {
    expect(createFirefoxAdapter().withdraw).toBeUndefined()
  })
})
