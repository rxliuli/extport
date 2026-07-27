import type { ActivationClient, PlanListener, Transport } from './index'

const MESSAGE_TYPE = '@extport/sdk:changed'

/**
 * 最小结构类型,避免依赖 @types/chrome / webextension-polyfill。
 * chrome MV3（99+）与 firefox 的 runtime 都满足此形状。
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
 * 基于 runtime 消息的跨上下文变更通知。与产品自身的消息库
 * （如 @webext-core/messaging）共存：各自按信封过滤,互不干扰。
 * runtime 消息会唤醒休眠的 MV3 service worker,这是它比
 * BroadcastChannel 可靠的原因。
 */
export function webextTransport(): Transport {
  return {
    broadcast() {
      try {
        // fire-and-forget；没有任何接收方时 chrome 会报
        // "Receiving end does not exist",一律忽略。
        // timestamp 让 @webext-core/messaging 这类严格校验信封的库把本消息
        // 归类为「格式合法但无监听器」而静默跳过,而非「格式非法」而抛错
        const result = getRuntime()?.sendMessage({ type: MESSAGE_TYPE, timestamp: Date.now() })
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          void (result as Promise<unknown>).catch(() => {})
        }
      } catch {
        // firefox 在无接收方时同步抛错,同样忽略
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
   * 生效档位变化时触发（激活、撤销、过期,含本上下文首次加载出
   * 非 free 档位的时刻）。任务恢复/暂停等产品反应写在这里。
   */
  onPlanChanged?: PlanListener<TTier, TLimit>
  /** 浏览器启动时向服务端校验激活状态,默认开启 */
  checkOnStartup?: boolean
}

/**
 * 在 background 入口的顶层同步调用,保证 SW 被消息唤醒时监听器已就位。
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
  // 让 background 一启动就持有正确快照；Pro 用户会触发
  // onPlanChanged(free -> pro),产品借此做启动时的任务恢复
  void client.getPlan().catch(() => {})
}
