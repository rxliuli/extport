import { createAnalyticsPinger, type AnalyticsOptions } from './analytics'

/**
 * @extport/sdk/wxt-analytics — the extport provider for @wxt-dev/analytics.
 * An adapter, not a foundation (docs/analytics-design.md § Integration): it
 * wraps the same ping client as @extport/sdk/analytics, so it shares that
 * storage and dedup — installing both integrations never double-reports.
 *
 * Structurally typed, no dependency on the @wxt-dev/analytics package — a
 * provider is just a (analytics, config) => { page, track, identify } function.
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

/** Internal lifecycle event name — routed through analytics.track so the wxt module's consent gate applies. */
const PING_EVENT = '__extport_ping'

export function extport(
  options: AnalyticsOptions,
): (analytics: WxtAnalyticsLike, config: WxtConfigLike) => WxtProviderUploads {
  return (analytics, config) => {
    const pinger = createAnalyticsPinger(options)

    // The provider is only initialized in the background (the wxt module's
    // front-end context is forwarded over a port), so this is the "background
    // woke up" hook — same pattern as Moderok. Routing through analytics.track
    // rather than pinging directly lets the module's enabled gate apply.
    getRuntime()?.onInstalled?.addListener(() => {
      void analytics.track(PING_EVENT)
    })
    void analytics.track(PING_EVENT)

    return {
      page: () => Promise.resolve(),
      identify: () => Promise.resolve(),
      track: async (event) => {
        if (event.event.name === PING_EVENT) return pinger.maybePing()
        // extport has no custom events (nowhere in the wire protocol to put
        // them) — for those, chain PostHog/Umami alongside in providers.
        if (config.debug) {
          console.debug(`[@extport/sdk] no custom events — "${event.event.name}" dropped`)
        }
      },
    }
  }
}
