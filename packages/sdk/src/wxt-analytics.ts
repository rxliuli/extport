import { createAnalyticsPinger, type AnalyticsOptions } from './analytics'

/**
 * @extport/sdk/wxt-analytics — @wxt-dev/analytics 的 extport provider。
 * 适配器而非地基(docs/analytics-design.md § Integration):壳套在
 * @extport/sdk/analytics 的同一 ping 客户端上,与 attachAnalytics 共享
 * 存储去重,双集成也不会重复上报。
 *
 * 结构性类型,不依赖 @wxt-dev/analytics 包——provider 就是一个
 * (analytics, config) => { page, track, identify } 的函数。
 */

interface WxtAnalyticsLike {
  track(eventName: string): Promise<void>
}

interface WxtConfigLike {
  debug?: boolean
}

interface WxtTrackEventLike {
  event: { name: string }
}

export interface WxtProviderUploads {
  page(event: unknown): Promise<void>
  track(event: WxtTrackEventLike): Promise<void>
  identify(event: unknown): Promise<void>
}

interface WxtRuntimeLike {
  onInstalled?: { addListener(callback: () => void): void }
}

function getRuntime(): WxtRuntimeLike | undefined {
  const g = globalThis as unknown as Record<string, { runtime?: WxtRuntimeLike } | undefined>
  return g['browser']?.runtime ?? g['chrome']?.runtime
}

/** 内部生命周期事件名——经 analytics.track 走一圈,让 wxt 模块的 consent 闸生效。 */
const PING_EVENT = '__extport_ping'

export function extport(
  options: AnalyticsOptions,
): (analytics: WxtAnalyticsLike, config: WxtConfigLike) => WxtProviderUploads {
  return (analytics, config) => {
    const pinger = createAnalyticsPinger(options)

    // provider 只在 background 初始化(wxt 模块的前端上下文经 port 转发),
    // 所以这里就是"background 醒来"的钩子——Moderok 同款模式。经
    // analytics.track 路由而非直接 ping,是为了让模块的 enabled 闸生效。
    getRuntime()?.onInstalled?.addListener(() => {
      void analytics.track(PING_EVENT)
    })
    void analytics.track(PING_EVENT)

    return {
      page: () => Promise.resolve(),
      identify: () => Promise.resolve(),
      track: async (event) => {
        if (event.event.name === PING_EVENT) return pinger.maybePing()
        // extport 没有自定义事件(线协议里无处可写)——需要埋点的话在
        // providers 数组里并联 PostHog/Umami。
        if (config.debug) {
          console.debug(`[@extport/sdk] no custom events — "${event.event.name}" dropped`)
        }
      },
    }
  }
}
