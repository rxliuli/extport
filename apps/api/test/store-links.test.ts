import { describe, expect, it } from 'vitest'
import { storeConsoleUrl } from '../src/lib/store-links'

// Every caller of this is a rejected/error/stale-review notification, never
// a "here's your listing" message — so the developer console, not the
// public consumer-facing page, is the useful link on every store (it's the
// only one that ever shows submission status, a rejection reason, or a
// draft's state). See the doc comment on storeConsoleUrl for the Edge
// incident that established this.
describe('storeConsoleUrl', () => {
  it('chrome: developer console deep link when publisherId is known', () => {
    expect(storeConsoleUrl('chrome', 'abc123', { publisherId: 'pub-456' })).toBe(
      'https://chrome.google.com/webstore/devconsole/pub-456/abc123/edit',
    )
  })

  it('chrome: falls back to the public listing when publisherId is unknown', () => {
    expect(storeConsoleUrl('chrome', 'abc123')).toBe('https://chromewebstore.google.com/detail/abc123')
  })

  it('firefox: developer hub versions page', () => {
    expect(storeConsoleUrl('firefox', 'my-addon')).toBe('https://addons.mozilla.org/en-US/developers/addon/my-addon/versions')
  })

  it('edge: always the Partner Center dashboard, not the public listing', () => {
    expect(storeConsoleUrl('edge', 'product-guid')).toBe('https://partner.microsoft.com/en-us/dashboard/microsoftedge/product-guid/packages/dashboard')
  })

  it('safari: App Store Connect distribution page, defaulting to macos', () => {
    expect(storeConsoleUrl('safari', '6743197230')).toBe('https://appstoreconnect.apple.com/apps/6743197230/distribution/macos/version/inflight')
  })

  it('safari: honors an explicit platform', () => {
    expect(storeConsoleUrl('safari', '6743197230', { platform: 'ios' })).toBe('https://appstoreconnect.apple.com/apps/6743197230/distribution/ios/version/inflight')
  })
})
