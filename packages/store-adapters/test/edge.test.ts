import { describe, expect, it } from 'vitest'
import { createEdgeAdapter } from '../src/edge'
import { queueFetch, unreachableFetch } from './fetch-stub'

const creds = { clientId: 'cid', apiKey: 'edge-key' }
const PRODUCT = 'prod-1'
const OP_LOCATION = { location: 'https://api.addons.microsoftedge.microsoft.com/v1/products/prod-1/submissions/draft/package/operations/op-1' }
// Real (tiny) intervals instead of vitest fake timers — see firefox.test.ts for why.
const FAST_POLL = { intervalMs: 1, attempts: 3 }

describe('edge adapter — getState', () => {
  it('reports the live version from the unofficial store-detail fallback', async () => {
    const { fetch, calls } = queueFetch([{ status: 200, body: { version: '1.2.3' } }])
    const state = await createEdgeAdapter(fetch).getState(creds, { storeItemId: PRODUCT })
    expect(state).toEqual({ live: { known: true, version: '1.2.3' }, inReview: { known: false } })
    expect(calls[0]!.url).toBe(`https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/${PRODUCT}`)
  })

  // storeItemId is the Partner Center Product ID (a GUID) — the Submission
  // API needs it, but this public fallback is keyed by the store-facing crx
  // id instead (a different Microsoft ID namespace entirely). crxId carries
  // that separately so both APIs get the id they actually expect.
  it('queries the store-detail fallback by crxId, not storeItemId, when both are set', async () => {
    const { fetch, calls } = queueFetch([{ status: 200, body: { version: '1.2.3' } }])
    const state = await createEdgeAdapter(fetch).getState(creds, { storeItemId: 'aa6b36e5-7dcc-4903-ae22-717280447cfc', crxId: 'flnakifokcbfogdggeieaonemaikfpid' })
    expect(state).toEqual({ live: { known: true, version: '1.2.3' }, inReview: { known: false } })
    expect(calls[0]!.url).toBe('https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/flnakifokcbfogdggeieaonemaikfpid')
  })

  // inReview can never be observed this way — the fallback is the public store
  // detail page's own data source, and review-in-progress state is never shown
  // to consumers.
  it('never reports inReview as known, even when live is', async () => {
    const { fetch } = queueFetch([{ status: 200, body: { version: '1.2.3' } }])
    const state = await createEdgeAdapter(fetch).getState(creds, { storeItemId: PRODUCT })
    expect(state.inReview).toEqual({ known: false })
  })

  it('falls back to known: false (not a thrown error) when the endpoint is unreachable', async () => {
    const state = await createEdgeAdapter(unreachableFetch).getState(creds, { storeItemId: PRODUCT })
    expect(state).toEqual({ live: { known: false }, inReview: { known: false } })
  })

  it('falls back to known: false when the endpoint responds but not with 200', async () => {
    const { fetch } = queueFetch([{ status: 404, body: 'not found' }])
    const state = await createEdgeAdapter(fetch).getState(creds, { storeItemId: PRODUCT })
    expect(state).toEqual({ live: { known: false }, inReview: { known: false } })
  })

  it('falls back to known: false when the response has no version field (unofficial endpoint changed shape)', async () => {
    const { fetch } = queueFetch([{ status: 200, body: { name: 'Some Extension' } }])
    const state = await createEdgeAdapter(fetch).getState(creds, { storeItemId: PRODUCT })
    expect(state).toEqual({ live: { known: false }, inReview: { known: false } })
  })
})

describe('edge adapter — submit', () => {
  it('uploads, validates, and submits for certification', async () => {
    const { fetch, calls } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 202 },
    ])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8))
    expect(result).toEqual({ submitted: true })
    expect(calls[0]!.url).toBe(`https://api.addons.microsoftedge.microsoft.com/v1/products/${PRODUCT}/submissions/draft/package`)
    expect(calls[1]!.url).toBe(`https://api.addons.microsoftedge.microsoft.com/v1/products/${PRODUCT}/submissions/draft/package/operations/op-1`)
    expect(calls[2]!.url).toBe(`https://api.addons.microsoftedge.microsoft.com/v1/products/${PRODUCT}/submissions`)
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ notes: 'Submitted automatically by extport.' })
  })

  it('polls the package operation until it succeeds', async () => {
    const { fetch, calls } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'InProgress' } },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 202 },
    ])
    const result = await createEdgeAdapter(fetch, FAST_POLL).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8))
    expect(result).toEqual({ submitted: true })
    expect(calls).toHaveLength(4)
  })

  it('gives up (not a failure) if validation is still in progress after the poll window', async () => {
    const entries = [
      { status: 202, headers: OP_LOCATION },
      ...Array.from({ length: FAST_POLL.attempts }, () => ({ status: 200, body: { status: 'InProgress' } })),
    ]
    const { fetch, calls } = queueFetch(entries)
    const result = await createEdgeAdapter(fetch, FAST_POLL).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8))
    expect(result.submitted).toBe(false)
    expect(result.detail).toMatch(/still in progress/)
    // upload + FAST_POLL.attempts polls, no submissions call
    expect(calls).toHaveLength(1 + FAST_POLL.attempts)
  })

  it('reports package validation failure with the error code and message', async () => {
    const { fetch, calls } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Failed', errorCode: 'PackageValidationFailure', message: 'bad manifest' } },
    ])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8))
    expect(result.submitted).toBe(false)
    expect(result.detail).toContain('PackageValidationFailure')
    expect(result.detail).toContain('bad manifest')
    expect(calls).toHaveLength(2)
  })

  it('reports a rejected package upload immediately', async () => {
    const { fetch, calls } = queueFetch([{ status: 400, body: 'bad zip' }])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8))
    expect(result.submitted).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('fails cleanly when no operation id comes back', async () => {
    const { fetch, calls } = queueFetch([{ status: 202 }])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8))
    expect(result.submitted).toBe(false)
    expect(result.detail).toMatch(/operation id/)
    expect(calls).toHaveLength(1)
  })

  it('reports a rejected certification submission', async () => {
    const { fetch } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 400, body: 'InProgressSubmission' },
    ])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8))
    expect(result.submitted).toBe(false)
  })
})

describe('edge adapter — no withdraw capability', () => {
  it('does not implement withdraw (Partner Center "Cancel submission" is UI-only)', () => {
    expect(createEdgeAdapter().withdraw).toBeUndefined()
  })
})
