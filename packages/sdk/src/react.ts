import { useSyncExternalStore } from 'react'
import type { ActivationClient, Plan } from './index'

/**
 * 订阅当前套餐。初始加载完成前返回 free（毫秒级）,之后随
 * 本上下文与其他上下文的激活/撤销自动更新。
 */
export function usePlan<TTier extends string, TLimit>(client: ActivationClient<TTier, TLimit>): Plan<TTier, TLimit> {
  return useSyncExternalStore(
    (onStoreChange) => client.subscribe(onStoreChange),
    () => client.getSnapshot(),
    () => client.getSnapshot(),
  )
}
