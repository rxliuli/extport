import { describe, expect, it } from 'vitest'
import { createEdgeAdapter } from '../src/edge'
import { queueFetch, unreachableFetch } from './fetch-stub'

const creds = { clientId: 'cid', apiKey: 'edge-key' }
const PRODUCT = 'prod-1'
const OP_LOCATION = { location: 'https://api.addons.microsoftedge.microsoft.com/v1/products/prod-1/submissions/draft/package/operations/op-1' }
const SUBMIT_OP_LOCATION = { location: 'https://api.addons.microsoftedge.microsoft.com/v1/products/prod-1/submissions/operations/op-2' }
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
  it('uploads, validates, submits for certification, and confirms the submission operation', async () => {
    const { fetch, calls } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 202, headers: SUBMIT_OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
    ])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result).toEqual({ submitted: true })
    expect(calls[0]!.url).toBe(`https://api.addons.microsoftedge.microsoft.com/v1/products/${PRODUCT}/submissions/draft/package`)
    expect(calls[1]!.url).toBe(`https://api.addons.microsoftedge.microsoft.com/v1/products/${PRODUCT}/submissions/draft/package/operations/op-1`)
    expect(calls[2]!.url).toBe(`https://api.addons.microsoftedge.microsoft.com/v1/products/${PRODUCT}/submissions`)
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ notes: 'Submitted automatically by extport.' })
    expect(calls[3]!.url).toBe(`https://api.addons.microsoftedge.microsoft.com/v1/products/${PRODUCT}/submissions/operations/op-2`)
  })

  it('polls the package operation until it succeeds', async () => {
    const { fetch, calls } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'InProgress' } },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 202, headers: SUBMIT_OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
    ])
    const result = await createEdgeAdapter(fetch, FAST_POLL).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result).toEqual({ submitted: true })
    expect(calls).toHaveLength(5)
  })

  // Same async shape as the package upload — a bare 202 from the submissions
  // POST only means the request was accepted, not that it left draft. Real
  // incident: a target sat at in_review for 10 days while Partner Center's
  // own UI still showed the version "In draft" because this poll didn't exist.
  it('polls the submission operation until it succeeds', async () => {
    const { fetch, calls } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 202, headers: SUBMIT_OP_LOCATION },
      { status: 200, body: { status: 'InProgress' } },
      { status: 200, body: { status: 'Succeeded' } },
    ])
    const result = await createEdgeAdapter(fetch, FAST_POLL).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result).toEqual({ submitted: true })
    expect(calls).toHaveLength(5)
  })

  // Retrying a submission poll timeout is unsafe (unlike the upload-
  // validation timeout above): re-submitting while the accepted request is
  // still processing gets rejected by Edge as "already in progress" — a
  // real production incident. So a timeout here falls back to trusting the
  // 202, not to `waiting: true`.
  it('accepts the 202 (does not retry) if the submission operation is still processing after the poll window', async () => {
    const entries = [
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 202, headers: SUBMIT_OP_LOCATION },
      ...Array.from({ length: FAST_POLL.attempts }, () => ({ status: 200, body: { status: 'InProgress' } })),
    ]
    const { fetch, calls } = queueFetch(entries)
    const result = await createEdgeAdapter(fetch, FAST_POLL).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result).toEqual({ submitted: true })
    // upload + validated + submit + FAST_POLL.attempts polls
    expect(calls).toHaveLength(3 + FAST_POLL.attempts)
  })

  it('reports submission operation failure with the error code and message', async () => {
    const { fetch, calls } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 202, headers: SUBMIT_OP_LOCATION },
      { status: 200, body: { status: 'Failed', errorCode: 'CertificationFailure', message: 'metadata rejected' } },
    ])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(result.detail).toContain('CertificationFailure')
    expect(result.detail).toContain('metadata rejected')
    expect(calls).toHaveLength(4)
  })

  it('fails cleanly when no operation id comes back for the submission', async () => {
    const { fetch, calls } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 202 },
    ])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(result.detail).toMatch(/operation id for the submission/)
    expect(calls).toHaveLength(3)
  })

  it('gives up (not a failure) if validation is still in progress after the poll window', async () => {
    const entries = [
      { status: 202, headers: OP_LOCATION },
      ...Array.from({ length: FAST_POLL.attempts }, () => ({ status: 200, body: { status: 'InProgress' } })),
    ]
    const { fetch, calls } = queueFetch(entries)
    const result = await createEdgeAdapter(fetch, FAST_POLL).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
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
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(result.detail).toContain('PackageValidationFailure')
    expect(result.detail).toContain('bad manifest')
    expect(calls).toHaveLength(2)
  })

  it('reports a rejected package upload immediately', async () => {
    const { fetch, calls } = queueFetch([{ status: 400, body: 'bad zip' }])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('fails cleanly when no operation id comes back', async () => {
    const { fetch, calls } = queueFetch([{ status: 202 }])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(result.detail).toMatch(/operation id/)
    expect(calls).toHaveLength(1)
  })

  it('treats InProgressSubmission on the submit POST as waiting, not an error', async () => {
    const { fetch } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 400, body: 'InProgressSubmission' },
    ])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(result.waiting).toBe(true)
    expect(result.detail).toMatch(/earlier submission/)
  })

  it('treats an InProgressSubmission operation result as waiting, not an error', async () => {
    const { fetch } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Failed', errorCode: 'InProgressSubmission', message: "Can't publish extension as your extension submission is in progress." } },
    ])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(result.waiting).toBe(true)
  })

  it('reports any other rejected certification submission as a real failure', async () => {
    const { fetch } = queueFetch([
      { status: 202, headers: OP_LOCATION },
      { status: 200, body: { status: 'Succeeded' } },
      { status: 400, body: 'NotAuthorized' },
    ])
    const result = await createEdgeAdapter(fetch).submit(creds, { storeItemId: PRODUCT }, new ArrayBuffer(8), '1.0.0')
    expect(result.submitted).toBe(false)
    expect(result.waiting).toBeUndefined()
    expect(result.detail).toContain('NotAuthorized')
  })
})

describe('edge adapter — no withdraw capability', () => {
  it('does not implement withdraw (Partner Center "Cancel submission" is UI-only)', () => {
    expect(createEdgeAdapter().withdraw).toBeUndefined()
  })
})
