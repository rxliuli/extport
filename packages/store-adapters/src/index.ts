import type { Store } from '@extport/shared'
import type { StoreAdapter } from './types'

export * from './types'

function notImplemented(store: Store): StoreAdapter {
  return {
    store,
    verifyCredentials: () => Promise.reject(new Error(`${store} adapter not implemented yet`)),
    getState: () => Promise.reject(new Error(`${store} adapter not implemented yet`)),
    submit: () => Promise.reject(new Error(`${store} adapter not implemented yet`)),
  }
}

// Milestone 3 replaces these stubs, in order: chrome → firefox → edge → apple.
const adapters: Record<Store, StoreAdapter> = {
  chrome: notImplemented('chrome'),
  firefox: notImplemented('firefox'),
  edge: notImplemented('edge'),
  apple: notImplemented('apple'),
}

export function getAdapter(store: Store): StoreAdapter {
  return adapters[store]
}
