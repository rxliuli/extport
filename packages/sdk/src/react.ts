import { useSyncExternalStore } from 'react'
import type { ActivationClient, Plan } from './index'

/**
 * Subscribe to the current plan. Returns `free` until the initial load
 * completes, then updates automatically as this context — or another context
 * via transport — activates or revokes.
 */
export function usePlan<TTier extends string, TLimit>(client: ActivationClient<TTier, TLimit>): Plan<TTier, TLimit> {
  return useSyncExternalStore(
    (onStoreChange) => client.subscribe(onStoreChange),
    () => client.getSnapshot(),
    () => client.getSnapshot(),
  )
}
