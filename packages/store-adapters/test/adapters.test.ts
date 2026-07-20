import { describe, expect, it } from 'vitest'
import { createAppleAdapter } from '../src/apple'
import { createChromeAdapter } from '../src/chrome'
import { createEdgeAdapter } from '../src/edge'
import { createFirefoxAdapter } from '../src/firefox'
import type { FetchLike } from '../src/util'

interface Captured {
  url: string
  init?: RequestInit
}

function stubFetch(status: number, body: unknown): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = []
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init })
      return Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      )
    },
  }
}

async function makeP8(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  let binary = ''
  for (const b of pkcs8) binary += String.fromCharCode(b)
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`
}

describe('chrome adapter', () => {
  const creds = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' }

  it('verifies via refresh-token exchange', async () => {
    const { fetch, calls } = stubFetch(200, { access_token: 'at' })
    const result = await createChromeAdapter(fetch).verifyCredentials(creds)
    expect(result).toEqual({ ok: true })
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
    expect(String(calls[0]!.init?.body)).toContain('grant_type=refresh_token')
  })

  it('reports invalid_grant as a definitive failure', async () => {
    const { fetch } = stubFetch(400, { error: 'invalid_grant' })
    const result = await createChromeAdapter(fetch).verifyCredentials(creds)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('invalid_grant')
  })

  it('throws (transient) on 5xx instead of marking invalid', async () => {
    const { fetch } = stubFetch(503, 'oops')
    await expect(createChromeAdapter(fetch).verifyCredentials(creds)).rejects.toThrow(/unavailable/)
  })
})

describe('firefox adapter', () => {
  const creds = { jwtIssuer: 'user:1:23', jwtSecret: 'amosecret' }

  it('sends a freshly signed JWT to the profile endpoint', async () => {
    const { fetch, calls } = stubFetch(200, { name: 'dev' })
    const result = await createFirefoxAdapter(fetch).verifyCredentials(creds)
    expect(result).toEqual({ ok: true })
    expect(calls[0]!.url).toBe('https://addons.mozilla.org/api/v5/accounts/profile/')
    const header = (calls[0]!.init?.headers as Record<string, string>).authorization
    expect(header).toMatch(/^JWT [\w-]+\.[\w-]+\.[\w-]+$/)
  })

  it('rejects on 401', async () => {
    const { fetch } = stubFetch(401, { detail: 'bad jwt' })
    const result = await createFirefoxAdapter(fetch).verifyCredentials(creds)
    expect(result.ok).toBe(false)
  })
})

describe('edge adapter', () => {
  const creds = { clientId: 'cid', apiKey: 'apikey' }

  it('treats 404 for the probe product as valid credentials', async () => {
    const { fetch, calls } = stubFetch(404, 'not found')
    const result = await createEdgeAdapter(fetch).verifyCredentials(creds)
    expect(result).toEqual({ ok: true })
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('ApiKey apikey')
    expect(headers['x-clientid']).toBe('cid')
  })

  it('treats 401/403 as invalid credentials', async () => {
    for (const status of [401, 403]) {
      const { fetch } = stubFetch(status, 'denied')
      const result = await createEdgeAdapter(fetch).verifyCredentials(creds)
      expect(result.ok).toBe(false)
    }
  })
})

describe('apple adapter', () => {
  it('signs an ES256 token and accepts 200', async () => {
    const creds = { keyId: 'KEY1', issuerId: 'iss-1', privateKeyP8: await makeP8() }
    const { fetch, calls } = stubFetch(200, { data: [] })
    const result = await createAppleAdapter(fetch).verifyCredentials(creds)
    expect(result).toEqual({ ok: true })
    expect(calls[0]!.url).toBe('https://api.appstoreconnect.apple.com/v1/apps?limit=1')
    const header = (calls[0]!.init?.headers as Record<string, string>).authorization
    expect(header).toMatch(/^Bearer /)
  })

  it('fails without network when the .p8 key is garbage', async () => {
    const creds = { keyId: 'KEY1', issuerId: 'iss-1', privateKeyP8: 'not-a-key' }
    const { fetch, calls } = stubFetch(200, {})
    const result = await createAppleAdapter(fetch).verifyCredentials(creds)
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
