import { describe, expect, it } from 'vitest'
import { parseListingUrl } from '../src/lib/store-listing-url'

describe('parseListingUrl', () => {
  it.each([
    [
      'https://chromewebstore.google.com/detail/redirector/lioaeidejmlpffbndjhaameocfldlhin',
      { store: 'chrome', field: 'storeItemId', id: 'lioaeidejmlpffbndjhaameocfldlhin' },
    ],
    [
      'https://chromewebstore.google.com/detail/lioaeidejmlpffbndjhaameocfldlhin?hl=zh-CN',
      { store: 'chrome', field: 'storeItemId', id: 'lioaeidejmlpffbndjhaameocfldlhin' },
    ],
    [
      'https://chrome.google.com/webstore/detail/redirector/lioaeidejmlpffbndjhaameocfldlhin',
      { store: 'chrome', field: 'storeItemId', id: 'lioaeidejmlpffbndjhaameocfldlhin' },
    ],
    [
      'chromewebstore.google.com/detail/redirector/lioaeidejmlpffbndjhaameocfldlhin',
      { store: 'chrome', field: 'storeItemId', id: 'lioaeidejmlpffbndjhaameocfldlhin' },
    ],
    [
      'https://addons.mozilla.org/en-US/firefox/addon/redirector-url/',
      { store: 'firefox', field: 'storeItemId', id: 'redirector-url' },
    ],
    [
      'https://addons.mozilla.org/firefox/addon/redirector-url',
      { store: 'firefox', field: 'storeItemId', id: 'redirector-url' },
    ],
    [
      'https://addons.mozilla.org/en-US/android/addon/redirector-url/reviews/',
      { store: 'firefox', field: 'storeItemId', id: 'redirector-url' },
    ],
    [
      'https://microsoftedge.microsoft.com/addons/detail/redirector/jhdjcofnjfeljeekjklhgfmfocfgibmm',
      { store: 'edge', field: 'crxId', id: 'jhdjcofnjfeljeekjklhgfmfocfgibmm' },
    ],
    [
      'https://apps.apple.com/us/app/url-redirector/id6743197230',
      { store: 'safari', field: 'storeItemId', id: '6743197230' },
    ],
    ['https://apps.apple.com/app/id6743197230', { store: 'safari', field: 'storeItemId', id: '6743197230' }],
    [
      '  https://apps.apple.com/us/app/url-redirector/id6743197230  ',
      { store: 'safari', field: 'storeItemId', id: '6743197230' },
    ],
  ])('%s', (input, expected) => {
    expect(parseListingUrl(input)).toEqual(expected)
  })

  it.each([
    // Bare ids are ambiguous (chrome item id vs edge crx id) — must pass through as typed.
    'lioaeidejmlpffbndjhaameocfldlhin',
    'fc0018c2-ecb8-4305-8ccf-b700cc62aba7',
    'redirector-url',
    '',
    'https://example.com/detail/redirector/lioaeidejmlpffbndjhaameocfldlhin',
    'https://chromewebstore.google.com/', // listing URL without an id
    'https://addons.mozilla.org/en-US/firefox/', // no /addon/ segment
    'https://apps.apple.com/us/app/url-redirector/', // no idNNN segment
    'not a url at all',
  ])('returns null for %j', (input) => {
    expect(parseListingUrl(input)).toBeNull()
  })
})
