import { idbStorage, type StorageAdapter } from './index'

/**
 * @extport/sdk/analytics — 每日 ping 客户端。线协议只有这一个事件:
 * install/update/active/departure 全部由服务端从 ping 流推断
 * (extport docs/analytics-design.md)。
 *
 * 与 licensing 的心跳裁决同一原则:不使用 alarms、不要求任何权限、
 * 事件驱动(background 醒来即是活跃的证明)。每 UTC 日至多一次,
 * 客户端与服务端各自独立去重。
 */

export interface AnalyticsOptions {
  /** extport 扩展 id(ext_…)——分析协议没有 licensing 的历史包袱,直接用它。 */
  extensionId: string
  /** 本地/自托管调试用,默认生产 extport。 */
  apiBase?: string
  /** 默认从 runtime.getManifest().version 读取。 */
  version?: string
  /** 默认 idb-keyval,与 licensing 共用同一 StorageAdapter 形状。 */
  storage?: StorageAdapter
  /** 存储键,默认 'extport-analytics'。 */
  storageKey?: string
  /**
   * 未曾显式 setEnabled 过时的初始值,默认 true(集成本身即租户的
   * 决定)。需要用户级同意流程的扩展传 false,并在取得同意后调
   * setEnabled(true)。
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
   * 当日未 ping 过则 ping,否则空操作。永不抛错——分析绝不能影响宿主。
   * 并发调用共享同一次执行。
   */
  maybePing(): Promise<void>
  /** 持久化开关;开启时立刻补一次当日 ping(同意即生效,不等明天)。 */
  setEnabled(enabled: boolean): Promise<void>
}

interface AnalyticsRuntime {
  onInstalled?: { addListener(callback: () => void): void }
  onStartup?: { addListener(callback: () => void): void }
  getManifest?(): { version: string }
}

function getAnalyticsRuntime(): AnalyticsRuntime | undefined {
  const g = globalThis as unknown as Record<string, { runtime?: AnalyticsRuntime } | undefined>
  return g['browser']?.runtime ?? g['chrome']?.runtime
}

export function createAnalyticsPinger(options: AnalyticsOptions): AnalyticsPinger {
  const apiBase = options.apiBase ?? 'https://api.extport.dev'
  const storage = options.storage ?? idbStorage
  const key = options.storageKey ?? 'extport-analytics'
  let inflight: Promise<void> | undefined

  async function doPing(): Promise<void> {
    const record = (await storage.get<AnalyticsRecord>(key)) ?? {}
    const today = new Date().toISOString().slice(0, 10)
    if (record.lastPingDate === today) return
    // 未同意时不写日期戳:当天晚些时候取得同意仍能补上当日的 ping。
    if (!(record.enabled ?? options.defaultEnabled ?? true)) return

    let installId = record.installId
    if (!installId) {
      // 先持久化再发送:发送失败重试时沿用同一身份,不产生幽灵安装。
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
        extensionId: options.extensionId,
        version,
        language: typeof navigator !== 'undefined' ? navigator.language : undefined,
      }),
    })
    // 只有确认送达才盖日期戳——失败留给下一次唤醒重试。
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
  }
}

/**
 * 在 background 入口顶层同步调用。background 每次冷启动本身就是
 * 每日 ping 的驱动时机;onInstalled 让安装当刻立即计数(安装时间
 * 因此精确到天而非等到下次唤醒)。
 */
export function attachAnalytics(options: AnalyticsOptions): AnalyticsPinger {
  const pinger = createAnalyticsPinger(options)
  const runtime = getAnalyticsRuntime()
  runtime?.onInstalled?.addListener(() => {
    void pinger.maybePing()
  })
  runtime?.onStartup?.addListener(() => {
    void pinger.maybePing()
  })
  void pinger.maybePing()
  return pinger
}
