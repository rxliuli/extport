import { describe, expect, it } from 'vitest'
import { createSafariAdapter } from '../src/safari'
import { queueFetch, unreachableFetch } from './fetch-stub'

const APP_ID = 'app-123'

async function makeP8(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  let binary = ''
  for (const b of pkcs8) binary += String.fromCharCode(b)
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`
}

async function creds() {
  return { keyId: 'KEY1', issuerId: 'iss-1', privateKeyP8: await makeP8() }
}

function version(versionString: string, appVersionState: string) {
  return { attributes: { versionString, appVersionState } }
}

describe('safari adapter — getState', () => {
  it('picks the live version and a pending-review version separately', async () => {
    const { fetch, calls } = queueFetch([
      {
        status: 200,
        body: { data: [version('1.1.0', 'WAITING_FOR_REVIEW'), version('1.0.0', 'READY_FOR_DISTRIBUTION')] },
      },
    ])
    const state = await createSafariAdapter(fetch).getState(await creds(), { storeItemId: APP_ID })
    expect(state).toEqual({ live: { known: true, version: '1.0.0' }, inReview: { known: true, version: '1.1.0' }, reviewStatus: 'pending', rejectionReason: undefined })
    expect(calls[0]!.url).toContain(`/v1/apps/${APP_ID}/appStoreVersions`)
    // One ASC app spans macOS + iOS with independent version timelines — without
    // this filter the response mixes platforms in arbitrary order and first-match
    // flips between them. macOS-only is the deliberate interim stance until the
    // spec §8 per-platform work.
    expect(calls[0]!.url).toContain('filter[platform]=MAC_OS')
  })

  it('reports a rejected version with a pointer to Activity, not a fabricated reason', async () => {
    const { fetch } = queueFetch([
      { status: 200, body: { data: [version('1.1.0', 'REJECTED'), version('1.0.0', 'READY_FOR_DISTRIBUTION')] } },
    ])
    const state = await createSafariAdapter(fetch).getState(await creds(), { storeItemId: APP_ID })
    expect(state.reviewStatus).toBe('rejected')
    expect(state.rejectionReason).toMatch(/App Store Connect/)
  })

  it('handles an app with no versions at all', async () => {
    const { fetch } = queueFetch([{ status: 200, body: { data: [] } }])
    const state = await createSafariAdapter(fetch).getState(await creds(), { storeItemId: APP_ID })
    expect(state).toEqual({ live: { known: true }, inReview: { known: true }, reviewStatus: undefined, rejectionReason: undefined })
  })

  it('throws on a lookup failure', async () => {
    const { fetch } = queueFetch([{ status: 500, body: 'oops' }])
    await expect(createSafariAdapter(fetch).getState(await creds(), { storeItemId: APP_ID })).rejects.toThrow(/versions lookup failed/)
  })
})

describe('safari adapter — withdraw', () => {
  it('cancels the in-flight review submission', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { data: [{ id: 'sub-1' }] } },
      { status: 200, body: {} },
    ])
    await createSafariAdapter(fetch).withdraw!(await creds(), { storeItemId: APP_ID })
    expect(calls[1]!.url).toBe('https://api.appstoreconnect.apple.com/v1/reviewSubmissions/sub-1')
    expect(calls[1]!.init?.method).toBe('PATCH')
    const body = JSON.parse(String(calls[1]!.init?.body))
    expect(body.data.attributes.canceled).toBe(true)
  })

  it('is a no-op when nothing is in review', async () => {
    const { fetch, calls } = queueFetch([{ status: 200, body: { data: [] } }])
    await createSafariAdapter(fetch).withdraw!(await creds(), { storeItemId: APP_ID })
    expect(calls).toHaveLength(1)
  })

  it('throws if the cancel patch fails', async () => {
    const { fetch } = queueFetch([{ status: 200, body: { data: [{ id: 'sub-1' }] } }, { status: 409, body: 'conflict' }])
    await expect(createSafariAdapter(fetch).withdraw!(await creds(), { storeItemId: APP_ID })).rejects.toThrow(/cancel failed/)
  })
})

describe('safari adapter — submit', () => {
  it('is documented as unimplemented rather than silently failing', async () => {
    await expect(createSafariAdapter(unreachableFetch).submit(await creds(), { storeItemId: APP_ID }, new ArrayBuffer(8))).rejects.toThrow(
      /App Store Connect API cannot upload a binary/,
    )
  })
})
