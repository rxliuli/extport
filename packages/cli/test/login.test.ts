import { describe, expect, it, vi } from 'vitest'
import { login } from '../src/login'

function capturedOpen() {
  let capturedUrl: string | undefined
  let resolveOpened!: () => void
  const opened = new Promise<void>((res) => {
    resolveOpened = res
  })
  const openBrowser = (url: string) => {
    capturedUrl = url
    resolveOpened()
  }
  return { openBrowser, opened, getUrl: () => capturedUrl! }
}

describe('login', () => {
  it('opens the dashboard authorize URL with the callback port, then exchanges the code it receives', async () => {
    const { openBrowser, opened, getUrl } = capturedOpen()
    const fetchImpl = vi.fn(async (url: string | Request | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://dash.extport.dev/api/v1/cli-auth/exchange')
      expect(JSON.parse(String(init?.body))).toEqual({ code: 'test-code-123' })
      return new Response(JSON.stringify({ key: 'sk_live_from_login' }), { status: 200 })
    })

    const loginPromise = login('https://dash.extport.dev', { openBrowser, fetchImpl, log: () => {} })

    await opened
    const authorizeUrl = new URL(getUrl())
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://dash.extport.dev/cli-auth')
    const port = authorizeUrl.searchParams.get('port')
    expect(port).toMatch(/^\d+$/)

    // Simulates the dashboard's redirect back after the tenant approves.
    const callbackRes = await fetch(`http://127.0.0.1:${port}/callback?code=test-code-123`)
    expect(callbackRes.status).toBe(200)

    expect(await loginPromise).toEqual({ apiKey: 'sk_live_from_login' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects if the dashboard redirects back with an error instead of a code', async () => {
    const { openBrowser, opened, getUrl } = capturedOpen()
    const loginPromise = login('https://dash.extport.dev', { openBrowser, log: () => {} })
    // Real usage always does `await login(...)` immediately, so the rejection
    // is never actually unhandled — but this test holds the promise in a
    // variable across several intervening awaits before asserting on it
    // below, which is enough of a gap for Node's unhandled-rejection
    // detector to fire a (harmless, test-only) false positive.
    loginPromise.catch(() => {})

    await opened
    const port = new URL(getUrl()).searchParams.get('port')
    await fetch(`http://127.0.0.1:${port}/callback?error=denied`)

    await expect(loginPromise).rejects.toThrow('denied')
  })

  it('rejects if the exchange request itself fails', async () => {
    const { openBrowser, opened, getUrl } = capturedOpen()
    const fetchImpl = vi.fn(async () => new Response('bad code', { status: 400 }))
    const loginPromise = login('https://dash.extport.dev', { openBrowser, fetchImpl, log: () => {} })
    loginPromise.catch(() => {})

    await opened
    const port = new URL(getUrl()).searchParams.get('port')
    await fetch(`http://127.0.0.1:${port}/callback?code=whatever`)

    await expect(loginPromise).rejects.toThrow(/login failed \(400\)/)
  })

  it('times out if the browser flow is never completed', async () => {
    const { openBrowser } = capturedOpen()
    await expect(login('https://dash.extport.dev', { openBrowser, log: () => {}, timeoutMs: 20 })).rejects.toThrow(/timed out/)
  })
})
