import type { ActivationClient, PlanListener, Transport } from './index'

const MESSAGE_TYPE = '@extport/sdk:changed'

/**
 * Minimal structural type so we avoid depending on @types/chrome or
 * webextension-polyfill. Both chrome MV3 (99+) and firefox runtime satisfy it.
 */
interface RuntimeLike {
  sendMessage(message: unknown): Promise<unknown> | void
  onMessage: { addListener(callback: (message: unknown) => void): void }
  onStartup?: { addListener(callback: () => void): void }
}

function getRuntime(): RuntimeLike | undefined {
  const g = globalThis as unknown as Record<string, { runtime?: RuntimeLike } | undefined>
  return g['browser']?.runtime ?? g['chrome']?.runtime
}

/**
 * Cross-context change notification over runtime messages. Coexists with a
 * product's own messaging library (e.g. @webext-core/messaging): each filters
 * by its own envelope, so they never interfere. Runtime messages wake a
 * sleeping MV3 service worker, which is why this is more reliable than
 * BroadcastChannel.
 */
export function webextTransport(): Transport {
  return {
    broadcast() {
      try {
        // fire-and-forget; chrome reports "Receiving end does not exist" when
        // there is no receiver, ignore it. The timestamp lets libraries that
        // strictly validate envelopes (e.g. @webext-core/messaging) classify
        // this as "valid shape, no listener" and skip silently rather than
        // throw on an "invalid shape".
        const result = getRuntime()?.sendMessage({ type: MESSAGE_TYPE, timestamp: Date.now() })
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          void (result as Promise<unknown>).catch(() => {})
        }
      } catch {
        // firefox throws synchronously when there is no receiver; ignore it too
      }
    },
    listen(onRemoteChange) {
      getRuntime()?.onMessage.addListener((message) => {
        if ((message as { type?: string } | null)?.type === MESSAGE_TYPE) {
          onRemoteChange()
        }
      })
    },
  }
}

export interface AttachBackgroundOptions<TTier extends string, TLimit> {
  /**
   * Fired when the effective tier changes (activation, revocation, expiry —
   * including the first time a non-free tier loads in this context). Put
   * product reactions like resuming/pausing work here.
   */
  onPlanChanged?: PlanListener<TTier, TLimit>
  /** 浏览器启动时向服务端校验激活状态,默认开启 */
  checkOnStartup?: boolean
}

/**
 * Call synchronously at the top level of the background entry, so the
 * listeners are already wired before the service worker is woken by a message.
 */
export function attachBackground<TTier extends string, TLimit>(
  client: ActivationClient<TTier, TLimit>,
  options: AttachBackgroundOptions<TTier, TLimit> = {},
): void {
  const { onPlanChanged, checkOnStartup = true } = options
  if (onPlanChanged) {
    client.subscribe(onPlanChanged)
  }
  if (checkOnStartup) {
    getRuntime()?.onStartup?.addListener(() => {
      client.checkActivation().catch((err) => {
        console.warn('checkActivation on startup failed:', err)
      })
    })
  }
  // Ensure the background holds a correct snapshot from the start; Pro users
  // trigger onPlanChanged(free -> pro), which the product uses to resume work
  // at startup.
  void client.getPlan().catch(() => {})
}
