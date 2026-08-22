import { idbStorage, resolveExtensionId, type StorageAdapter } from './index'

/**
 * A hand-rolled IndexedDB open (idb-keyval's default) has more that can go
 * wrong at creation time than a plain key-value store — confirmed against a
 * real incident (BilingualTube: a corrupted `keyval-store` database made
 * every read fail, so `installId` never persisted and every ping minted a
 * fresh one — 87% of recorded "installs" were one-off). `browser.storage.local`
 * has no such failure mode, but it requires the `storage` permission, which
 * not every extension declares (the WXT module's build-time check pushes
 * new integrations toward declaring it — see packages/wxt). Prefer it when
 * present, fall back to idb-keyval when it's not, so an extension that
 * hasn't added the permission yet keeps working exactly as before.
 */
interface StorageLocalApi {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

function getStorageLocal(): StorageLocalApi | undefined {
  const g = globalThis as unknown as Record<string, { storage?: { local?: StorageLocalApi } } | undefined>
  return g['browser']?.storage?.local ?? g['chrome']?.storage?.local
}

function browserStorageAdapter(local: StorageLocalApi): StorageAdapter {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const result = await local.get([key])
      return result[key] as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      await local.set({ [key]: value })
    },
    // Analytics never deletes its record (setEnabled(false) just flips a
    // flag) — del() is part of StorageAdapter's shape for licensing's sake,
    // not something this module's callers ever invoke.
    del: () => Promise.resolve(),
  }
}

function resolveAnalyticsStorage(): StorageAdapter {
  const local = getStorageLocal()
  return local ? browserStorageAdapter(local) : idbStorage
}

/**
 * @extport/sdk/analytics — the daily ping client. The wire protocol has a
 * single event: install/update/active/departure are all inferred server-side
 * from the ping stream (extport docs/analytics-design.md).
 *
 * Same principle as licensing's heartbeat: no alarms, no permissions required,
 * purely event-driven (the background waking is itself proof of activity). At
 * most once per UTC day, deduplicated independently on client and server.
 */

export interface AnalyticsOptions {
  /**
   * The extport extension id (ext_…). Optional: resolved automatically when
   * the @extport/wxt module injects `globalThis.__EXTPORT__.extensionId`. If
   * neither is present, silently report nothing (analytics must never affect
   * the host); warn once in dev.
   */
  extensionId?: string
  /** For local/self-hosted debugging; defaults to the production extport. */
  apiBase?: string
  /** Defaults to runtime.getManifest().version. */
  version?: string
  /** Defaults to idb-keyval, the same StorageAdapter shape licensing uses. */
  storage?: StorageAdapter
  /** Storage key; defaults to 'extport-analytics'. */
  storageKey?: string
  /**
   * Initial value before setEnabled is ever called; defaults to true (installing
   * the integration is itself the tenant's decision). Extensions needing a
   * user-level consent flow pass false and call setEnabled(true) once consent is
   * obtained.
   */
  defaultEnabled?: boolean
}

interface AnalyticsRecord {
  installId?: string
  lastPingDate?: string
  enabled?: boolean
}

export interface AnalyticsPinger {
  /**
   * Ping if not already pinged today, otherwise no-op. Never throws — analytics
   * must never affect the host. Concurrent calls share a single execution.
   */
  maybePing(): Promise<void>
  /** Persist the enabled flag; when turned on, immediately backfill today's ping. */
  setEnabled(enabled: boolean): Promise<void>
  /**
   * The current app-level flag, for drawing an opt-out toggle on an options
   * page. Falls back to defaultEnabled (default true) when never explicitly
   * set. Reflects app-level intent only — it does not read Firefox's
   * technicalAndInteraction browser-level permission, which is a separate
   * second gate checked at ping time (reading it here couldn't stay in sync
   * across contexts).
   */
  getEnabled(): Promise<boolean>
}

interface AnalyticsRuntime {
  onInstalled?: { addListener(callback: () => void): void }
  onStartup?: { addListener(callback: () => void): void }
  getManifest?(): { version: string }
}

interface PermissionsApi {
  getAll?(): Promise<Record<string, unknown>>
  onAdded?: { addListener(callback: () => void): void }
}

function getAnalyticsRuntime(): AnalyticsRuntime | undefined {
  const g = globalThis as unknown as Record<string, { runtime?: AnalyticsRuntime } | undefined>
  return g['browser']?.runtime ?? g['chrome']?.runtime
}

function getPermissionsApi(): PermissionsApi | undefined {
  const g = globalThis as unknown as Record<string, { permissions?: PermissionsApi } | undefined>
  return g['browser']?.permissions ?? g['chrome']?.permissions
}

/**
 * Firefox 140+'s built-in data-collection consent: when permissions.getAll()
 * returns a data_collection array, technicalAndInteraction must be in it (the
 * install dialog / about:addons switch). A missing key means the browser has no
 * such mechanism, so the manifest-level disclosure is the standard — allow.
 * Read at ping time, no listener needed on revoke; the next ping self-checks.
 */
async function browserConsentsToAnalytics(): Promise<boolean> {
  try {
    const permissions = getPermissionsApi()
    if (!permissions?.getAll) return true
    const all = (await permissions.getAll()) as { data_collection?: string[] }
    return all.data_collection === undefined || all.data_collection.includes('technicalAndInteraction')
  } catch {
    // 只有没有该机制的环境才可能走到这——同"键不存在"处理。
    return true
  }
}

export function createAnalyticsPinger(options: AnalyticsOptions = {}): AnalyticsPinger {
  const apiBase = options.apiBase ?? 'https://api.extport.dev'
  const storage = options.storage ?? resolveAnalyticsStorage()
  const key = options.storageKey ?? 'extport-analytics'
  let inflight: Promise<void> | undefined
  let warnedMissingId = false

  async function doPing(): Promise<void> {
    const extensionId = resolveExtensionId(options.extensionId)
    if (!extensionId) {
      if (!warnedMissingId) {
        warnedMissingId = true
        console.warn('[@extport/sdk] analytics: no extensionId (neither passed nor injected by @extport/wxt) — pings disabled')
      }
      return
    }
    const record = (await storage.get<AnalyticsRecord>(key)) ?? {}
    const today = new Date().toISOString().slice(0, 10)
    if (record.lastPingDate === today) return
    // Two independent consent gates, neither stamps the date: consent obtained
    // later the same day can still backfill today's ping. ① app-level flag
    // (setEnabled/defaultEnabled, for a custom consent flow); ② browser-level
    // (Firefox's technicalAndInteraction switch, respected automatically, zero
    // tenant wiring).
    if (!(record.enabled ?? options.defaultEnabled ?? true)) return
    if (!(await browserConsentsToAnalytics())) return

    let installId = record.installId
    if (!installId) {
      // Persist before sending: on retry the same identity is reused, so no
      // phantom installs are created.
      installId = crypto.randomUUID()
      record.installId = installId
      await storage.set(key, record)
    }

    const version = options.version ?? getAnalyticsRuntime()?.getManifest?.().version ?? '0.0.0'
    const resp = await fetch(`${apiBase}/api/v1/analytics/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installId,
        extensionId,
        version,
        language: typeof navigator !== 'undefined' ? navigator.language : undefined,
      }),
    })
    // Only stamp the date once delivery is confirmed — a failure is left for
    // the next wake to retry.
    if (resp.ok) {
      await storage.set(key, { ...record, lastPingDate: today })
    }
  }

  const maybePing = (): Promise<void> => {
    inflight ??= doPing()
      .catch(() => {})
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  return {
    maybePing,
    async setEnabled(enabled: boolean): Promise<void> {
      const record = (await storage.get<AnalyticsRecord>(key)) ?? {}
      await storage.set(key, { ...record, enabled })
      if (enabled) await maybePing()
    },
    async getEnabled(): Promise<boolean> {
      const record = await storage.get<AnalyticsRecord>(key)
      return record?.enabled ?? options.defaultEnabled ?? true
    },
  }
}

/**
 * Call synchronously at the top level of the background entry. Each cold start
 * of the background is itself the driver for the daily ping; onInstalled counts
 * the install immediately (so install time is exact to the day instead of
 * waiting for the next wake).
 */
export function attachAnalytics(options: AnalyticsOptions = {}): AnalyticsPinger {
  const pinger = createAnalyticsPinger(options)
  const runtime = getAnalyticsRuntime()
  runtime?.onInstalled?.addListener(() => {
    void pinger.maybePing()
  })
  runtime?.onStartup?.addListener(() => {
    void pinger.maybePing()
  })
  // A Firefox user who turns the data-collection switch on in about:addons
  // today gets counted today.
  getPermissionsApi()?.onAdded?.addListener(() => {
    void pinger.maybePing()
  })
  void pinger.maybePing()
  return pinger
}
