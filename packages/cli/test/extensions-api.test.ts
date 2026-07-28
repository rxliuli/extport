import { describe, expect, it, vi } from 'vitest'
import { fetchEnabledTargets } from '../src/extensions-api'

const matrixBody = {
  extensions: [
    {
      id: 'ext_1',
      targets: [
        { store: 'chrome', enabled: true },
        { store: 'firefox', enabled: true },
        { store: 'edge', enabled: false },
      ],
    },
  ],
}

describe('fetchEnabledTargets', () => {
  it('resolves the extension by id and filters to enabled targets only', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://dash.extport.dev/api/v1/extensions/matrix')
      return new Response(JSON.stringify(matrixBody), { status: 200 })
    })

    const byId = await fetchEnabledTargets('https://dash.extport.dev', 'sk_live_x', 'ext_1', fetchImpl)
    expect(byId).toEqual([
      { store: 'chrome', enabled: true },
      { store: 'firefox', enabled: true },
    ])
  })

  it('sends the api key as a bearer token', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk_live_x')
      return new Response(JSON.stringify(matrixBody), { status: 200 })
    })
    await fetchEnabledTargets('https://dash.extport.dev', 'sk_live_x', 'ext_1', fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws when the extension is not found', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(matrixBody), { status: 200 }))
    await expect(fetchEnabledTargets('https://dash.extport.dev', 'sk_live_x', 'nope', fetchImpl)).rejects.toThrow(/"nope" not found/)
  })

  it('throws when the request itself fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    await expect(fetchEnabledTargets('https://dash.extport.dev', 'bad-key', 'ext_1', fetchImpl)).rejects.toThrow(/\(401\)/)
  })

  it('normalises to chrome/firefox/edge/safari regardless of the order the server returns them in', async () => {
    const body = {
      extensions: [
        {
          id: 'ext_1',
          // The matrix endpoint returns targets in DB insertion order, which
          // is whatever order the tenant happened to add credentials in —
          // safari-first here, matching a real response seen in the wild.
          targets: [
            { store: 'safari', enabled: true },
            { store: 'chrome', enabled: true },
            { store: 'firefox', enabled: true },
            { store: 'edge', enabled: true },
          ],
        },
      ],
    }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    const targets = await fetchEnabledTargets('https://dash.extport.dev', 'sk_live_x', 'ext_1', fetchImpl)
    expect(targets.map((t) => t.store)).toEqual(['chrome', 'firefox', 'edge', 'safari'])
  })
})
