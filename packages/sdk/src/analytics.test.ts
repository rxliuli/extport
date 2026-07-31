import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachAnalytics, createAnalyticsPinger } from './analytics'
import { extport } from './wxt-analytics'
import type { StorageAdapter } from './index'

function memoryStorage(): StorageAdapter & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async (key, value) => void data.set(key, value),
    del: async (key) => void data.delete(key),
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const OPTIONS = { extensionId: 'ext_test', version: '1.2.3', apiBase: 'https://api.example.test' }

describe('createAnalyticsPinger', () => {
  it('pings once per UTC day with a persisted install id', async () => {
    const storage = memoryStorage()
    const pinger = createAnalyticsPinger({ ...OPTIONS, storage })

    await pinger.maybePing()
    await pinger.maybePing()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.test/api/v1/analytics/ping')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.extensionId).toBe('ext_test')
    expect(body.version).toBe('1.2.3')
    expect(typeof body.installId).toBe('string')

    // Same identity forever — a fresh pinger (next SW cold start) reuses it.
    const record = storage.data.get('extport-analytics') as { installId: string; lastPingDate: string }
    expect(record.installId).toBe(body.installId)
    expect(record.lastPingDate).toBe(new Date().toISOString().slice(0, 10))
  })

  it('does not stamp the day on failure, so the next wake retries with the same id', async () => {
    const storage = memoryStorage()
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const pinger = createAnalyticsPinger({ ...OPTIONS, storage })

    await pinger.maybePing() // swallowed — analytics never throws into the host
    const afterFailure = storage.data.get('extport-analytics') as { installId: string; lastPingDate?: string }
    expect(afterFailure.installId).toBeDefined()
    expect(afterFailure.lastPingDate).toBeUndefined()

    await pinger.maybePing()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string) as {
      installId: string
    }
    expect(secondBody.installId).toBe(afterFailure.installId)
  })

  it('respects the consent flag without burning the day, and pings immediately on enable', async () => {
    const storage = memoryStorage()
    const pinger = createAnalyticsPinger({ ...OPTIONS, storage, defaultEnabled: false })

    await pinger.maybePing()
    expect(fetchMock).not.toHaveBeenCalled()

    // Consent granted later the same day — the ping still counts today.
    await pinger.setEnabled(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('merges concurrent calls into one request', async () => {
    const storage = memoryStorage()
    let release!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)))
    const pinger = createAnalyticsPinger({ ...OPTIONS, storage })

    const both = Promise.all([pinger.maybePing(), pinger.maybePing()])
    release(new Response(null, { status: 204 }))
    await both
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('extensionId resolution', () => {
  it('falls back to the id injected by @extport/wxt', async () => {
    vi.stubGlobal('__EXTPORT__', { extensionId: 'ext_injected' })
    const storage = memoryStorage()
    const pinger = createAnalyticsPinger({ version: '1.0.0', apiBase: 'https://api.example.test', storage })
    await pinger.maybePing()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      extensionId: string
    }
    expect(body.extensionId).toBe('ext_injected')
  })

  it('an explicit id wins over the injected one', async () => {
    vi.stubGlobal('__EXTPORT__', { extensionId: 'ext_injected' })
    const storage = memoryStorage()
    const pinger = createAnalyticsPinger({ ...OPTIONS, storage })
    await pinger.maybePing()
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      extensionId: string
    }
    expect(body.extensionId).toBe('ext_test')
  })

  it('stays silent (never throws) when no id is resolvable', async () => {
    const storage = memoryStorage()
    const pinger = createAnalyticsPinger({ apiBase: 'https://api.example.test', storage })
    await pinger.maybePing()
    await pinger.maybePing()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(storage.data.size).toBe(0)
  })
})

describe('browser data-collection consent (Firefox 140+)', () => {
  function stubPermissions(dataCollection: string[] | undefined) {
    const listeners: (() => void)[] = []
    vi.stubGlobal('browser', {
      permissions: {
        getAll: async () => (dataCollection === undefined ? {} : { data_collection: dataCollection }),
        onAdded: { addListener: (cb: () => void) => listeners.push(cb) },
      },
    })
    return listeners
  }

  it('does not ping while technicalAndInteraction is off, and never burns the day', async () => {
    stubPermissions([])
    const storage = memoryStorage()
    const pinger = createAnalyticsPinger({ ...OPTIONS, storage })
    await pinger.maybePing()
    expect(fetchMock).not.toHaveBeenCalled()
    const record = storage.data.get('extport-analytics') as { lastPingDate?: string } | undefined
    expect(record?.lastPingDate).toBeUndefined()
  })

  it('pings once the toggle is granted — same day', async () => {
    const listeners = stubPermissions([])
    const storage = memoryStorage()
    const pinger = attachAnalytics({ ...OPTIONS, storage })
    await pinger.maybePing()
    expect(fetchMock).not.toHaveBeenCalled()

    // User flips the toggle in about:addons → onAdded fires → fresh
    // getAll() now grants.
    stubPermissions(['technicalAndInteraction'])
    for (const cb of listeners) cb()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('treats browsers without the mechanism as governed by the manifest disclosure', async () => {
    stubPermissions(undefined) // getAll() has no data_collection key
    const storage = memoryStorage()
    const pinger = createAnalyticsPinger({ ...OPTIONS, storage })
    await pinger.maybePing()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('attachAnalytics', () => {
  it('pings on attach and registers install/startup listeners', async () => {
    const listeners: Record<string, () => void> = {}
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: { addListener: (cb: () => void) => (listeners.installed = cb) },
        onStartup: { addListener: (cb: () => void) => (listeners.startup = cb) },
        getManifest: () => ({ version: '9.9.9' }),
      },
    })
    const storage = memoryStorage()
    attachAnalytics({ extensionId: 'ext_test', apiBase: 'https://api.example.test', storage })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      version: string
    }
    expect(body.version).toBe('9.9.9')
    expect(listeners.installed).toBeDefined()
    expect(listeners.startup).toBeDefined()

    // Later wakes re-enter through the same dedup.
    listeners.startup!()
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('wxt provider', () => {
  function wxtHarness(enabled: boolean, storage = memoryStorage()) {
    // Minimal stand-in for @wxt-dev/analytics' background client: track()
    // fans out to providers only when the consent gate is open.
    const uploads: ReturnType<ReturnType<typeof extport>>[] = []
    const analytics = {
      track: async (name: string) => {
        // The real module awaits getBaseEvent() before fanning out, so a
        // provider's init-time track lands after registration completes —
        // mirror that microtask delay.
        await Promise.resolve()
        if (!enabled) return
        for (const u of uploads) await u.track({ event: { name } })
      },
    }
    const provider = extport({ ...OPTIONS, storage })(analytics, { debug: false })
    uploads.push(provider)
    return { provider, analytics }
  }

  it('pings through the module gate on init and drops custom events', async () => {
    const { provider } = wxtHarness(true)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    await provider.track({ event: { name: 'my_custom_event' } })
    await provider.page({})
    await provider.identify({})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stays silent while the wxt consent gate is closed', async () => {
    wxtHarness(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shares the daily stamp with attachAnalytics — double integration, one ping', async () => {
    const storage = memoryStorage()
    attachAnalytics({ ...OPTIONS, storage })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    wxtHarness(true, storage)
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
