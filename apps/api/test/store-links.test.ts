import { describe, expect, it } from 'vitest'
import { storeConsoleUrl } from '../src/lib/store-links'

describe('storeConsoleUrl', () => {
  it('chrome: public listing by item id', () => {
    expect(storeConsoleUrl('chrome', 'abc123')).toBe('https://chromewebstore.google.com/detail/abc123')
  })

  it('firefox: public listing by slug', () => {
    expect(storeConsoleUrl('firefox', 'my-addon')).toBe('https://addons.mozilla.org/firefox/addon/my-addon/')
  })

  it('edge: public listing by crx id when known', () => {
    expect(storeConsoleUrl('edge', 'product-guid', { crxId: 'crxid123' })).toBe('https://microsoftedge.microsoft.com/addons/detail/crxid123')
  })

  it('edge: falls back to the Partner Center dashboard when crx id is unknown', () => {
    expect(storeConsoleUrl('edge', 'product-guid')).toBe('https://partner.microsoft.com/en-us/dashboard/microsoftedge/product-guid/packages/dashboard')
  })

  it('safari: App Store Connect distribution page, defaulting to macos', () => {
    expect(storeConsoleUrl('safari', '6743197230')).toBe('https://appstoreconnect.apple.com/apps/6743197230/distribution/macos/version/inflight')
  })

  it('safari: honors an explicit platform', () => {
    expect(storeConsoleUrl('safari', '6743197230', { platform: 'ios' })).toBe('https://appstoreconnect.apple.com/apps/6743197230/distribution/ios/version/inflight')
  })
})
