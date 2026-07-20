import { describe, expect, it } from 'vitest'
import { createChromeAdapter } from '../src/chrome'
import { queueFetch, unreachableFetch } from './fetch-stub'

async function makeServiceAccountKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  let binary = ''
  for (const b of pkcs8) binary += String.fromCharCode(b)
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`
}

async function creds() {
  return { publisherId: 'pub-1', clientEmail: 'sa@project.iam.gserviceaccount.com', privateKey: await makeServiceAccountKey() }
}

const ITEM = 'ext-abc'

describe('chrome adapter — auth', () => {
  it('verifies by exchanging a self-signed JWT-bearer assertion for an access token', async () => {
    const { fetch, calls } = queueFetch([{ status: 200, body: { access_token: 'at' } }])
    const result = await createChromeAdapter(fetch).verifyCredentials(await creds())
    expect(result).toEqual({ ok: true })
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
    const body = String(calls[0]!.init?.body)
    expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer')
    expect(body).toMatch(/assertion=[\w-]+\.[\w-]+\.[\w-]+/)
  })

  it('fails without a network call when the private key is garbage', async () => {
    const { fetch, calls } = queueFetch([{ status: 200, body: {} }])
    const result = await createChromeAdapter(fetch).verifyCredentials({
      publisherId: 'p',
      clientEmail: 'sa@x.iam.gserviceaccount.com',
      privateKey: 'not-a-key',
    })
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reports a rejected service account as a definitive failure', async () => {
    const { fetch } = queueFetch([{ status: 400, body: { error: 'invalid_grant' } }])
    const result = await createChromeAdapter(fetch).verifyCredentials(await creds())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('invalid_grant')
  })

  it('throws (transient) on a 5xx from Google', async () => {
    const { fetch } = queueFetch([{ status: 503, body: 'oops' }])
    await expect(createChromeAdapter(fetch).verifyCredentials(await creds())).rejects.toThrow(/unavailable/)
  })
})

describe('chrome adapter — getState', () => {
  it('maps published + pending-review revisions', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { access_token: 'at' } },
      {
        status: 200,
        body: {
          publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.0.0' }] },
          submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.1.0' }] },
        },
      },
    ])
    const state = await createChromeAdapter(fetch).getState(await creds(), ITEM)
    expect(state).toEqual({ live: { known: true, version: '1.0.0' }, inReview: { known: true, version: '1.1.0' }, reviewStatus: 'pending' })
    expect(calls[1]!.url).toBe(`https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/${ITEM}:fetchStatus`)
  })

  it('maps a rejected submission without exposing a real reason (Google does not provide one)', async () => {
    const { fetch } = queueFetch([
      { status: 200, body: { access_token: 'at' } },
      {
        status: 200,
        body: {
          publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.0.0' }] },
          submittedItemRevisionStatus: { state: 'REJECTED', distributionChannels: [{ crxVersion: '1.1.0' }] },
        },
      },
    ])
    const state = await createChromeAdapter(fetch).getState(await creds(), ITEM)
    expect(state.live).toEqual({ known: true, version: '1.0.0' })
    expect(state.inReview).toEqual({ known: true })
    expect(state.reviewStatus).toBe('rejected')
    expect(state.rejectionReason).toMatch(/does not expose rejection reasons/)
  })

  it('handles a brand-new item with nothing submitted yet', async () => {
    const { fetch } = queueFetch([{ status: 200, body: { access_token: 'at' } }, { status: 200, body: {} }])
    const state = await createChromeAdapter(fetch).getState(await creds(), ITEM)
    expect(state).toEqual({ live: { known: true }, inReview: { known: true } })
  })
})

describe('chrome adapter — submit', () => {
  it('uploads then publishes on success', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { access_token: 'at' } },
      { status: 200, body: { uploadState: 'SUCCEEDED' } },
      { status: 200, body: {} },
    ])
    const result = await createChromeAdapter(fetch).submit(await creds(), ITEM, new ArrayBuffer(8))
    expect(result).toEqual({ submitted: true })
    expect(calls[1]!.url).toBe(`https://chromewebstore.googleapis.com/upload/v2/publishers/pub-1/items/${ITEM}:upload`)
    expect(calls[2]!.url).toBe(`https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/${ITEM}:publish`)
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ publishType: 'DEFAULT_PUBLISH' })
  })

  it('stops and reports failure without publishing if the upload state is not SUCCEEDED', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { access_token: 'at' } },
      { status: 200, body: { uploadState: 'FAILURE', itemError: [{ error_code: 'PKG_MANIFEST_PARSE_ERROR' }] } },
    ])
    const result = await createChromeAdapter(fetch).submit(await creds(), ITEM, new ArrayBuffer(8))
    expect(result.submitted).toBe(false)
    expect(result.detail).toContain('PKG_MANIFEST_PARSE_ERROR')
    expect(calls).toHaveLength(2)
  })

  it('reports a failed publish call', async () => {
    const { fetch } = queueFetch([
      { status: 200, body: { access_token: 'at' } },
      { status: 200, body: { uploadState: 'SUCCEEDED' } },
      { status: 400, body: 'bad request' },
    ])
    const result = await createChromeAdapter(fetch).submit(await creds(), ITEM, new ArrayBuffer(8))
    expect(result.submitted).toBe(false)
  })
})

describe('chrome adapter — withdraw', () => {
  it('cancels the active submission', async () => {
    const { fetch, calls } = queueFetch([{ status: 200, body: { access_token: 'at' } }, { status: 200, body: {} }])
    await createChromeAdapter(fetch).withdraw!(await creds(), ITEM)
    expect(calls[1]!.url).toBe(`https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/${ITEM}:cancelSubmission`)
    expect(calls[1]!.init?.body).toBe('{}')
  })

  it('throws on failure', async () => {
    const { fetch } = queueFetch([{ status: 200, body: { access_token: 'at' } }, { status: 500, body: 'oops' }])
    await expect(createChromeAdapter(fetch).withdraw!(await creds(), ITEM)).rejects.toThrow(/cancelSubmission failed/)
  })
})

describe('chrome adapter — unreachable', () => {
  it('never calls fetch when the private key fails to sign', async () => {
    const result = await createChromeAdapter(unreachableFetch).verifyCredentials({
      publisherId: 'p',
      clientEmail: 'sa@x.iam.gserviceaccount.com',
      privateKey: 'garbage',
    })
    expect(result.ok).toBe(false)
  })
})
