import type { Store } from '@extport/shared'
import { createAppleAdapter } from './apple'
import { createChromeAdapter } from './chrome'
import { createEdgeAdapter } from './edge'
import { createFirefoxAdapter } from './firefox'
import type { StoreAdapter } from './types'
import type { CredentialsByStore } from './validate'

export * from './types'
export * from './validate'
export { signJwtES256, signJwtHS256, signJwtRS256, pemToPkcs8 } from './jwt'
export { createAppleAdapter } from './apple'
export { createChromeAdapter } from './chrome'
export { createEdgeAdapter } from './edge'
export { createFirefoxAdapter } from './firefox'
export { pollUntil, sleep } from './util'
export type { FetchLike } from './util'

const adapters: { [S in Store]: StoreAdapter<CredentialsByStore[S]> } = {
  chrome: createChromeAdapter(),
  firefox: createFirefoxAdapter(),
  edge: createEdgeAdapter(),
  apple: createAppleAdapter(),
}

export function getAdapter<S extends Store>(store: S): StoreAdapter<CredentialsByStore[S]> {
  return adapters[store]
}
