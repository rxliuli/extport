import type { Store } from '@extport/shared'
import { createChromeAdapter } from './chrome'
import { createEdgeAdapter } from './edge'
import { createFirefoxAdapter } from './firefox'
import { createSafariAdapter } from './safari'
import type { StoreAdapter } from './types'
import type { CredentialsByStore } from './validate'

export * from './types'
export * from './validate'
export { signJwtES256, signJwtHS256, signJwtRS256, pemToPkcs8 } from './jwt'
export { createChromeAdapter } from './chrome'
export { createEdgeAdapter } from './edge'
export { createFirefoxAdapter } from './firefox'
export { createSafariAdapter } from './safari'
export { pollUntil, sleep } from './util'
export type { FetchLike } from './util'

const adapters: { [S in Store]: StoreAdapter<CredentialsByStore[S]> } = {
  chrome: createChromeAdapter(),
  firefox: createFirefoxAdapter(),
  edge: createEdgeAdapter(),
  safari: createSafariAdapter(),
}

export function getAdapter<S extends Store>(store: S): StoreAdapter<CredentialsByStore[S]> {
  return adapters[store]
}
