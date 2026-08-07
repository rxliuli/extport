import { describe, expect, it } from 'vitest'
import { applyBundleIds, parseProjectVersion, resolveBundleIds } from '../src/safari-xcode'

describe('parseProjectVersion', () => {
  it('encodes major/minor/patch into a single integer', () => {
    expect(parseProjectVersion('1.2.3')).toBe(10203)
    expect(parseProjectVersion('0.1.0')).toBe(100)
  })
})

/**
 * The `objects` map exactly as plutil hands it back: a flat id -> object
 * dictionary, where a target points at a configuration list, which points at
 * the configurations that actually carry PRODUCT_BUNDLE_IDENTIFIER.
 */
function objects(targets: { name: string; productType: string; configIds: [string, string] }[]) {
  const map: Record<string, unknown> = {}
  targets.forEach((target, i) => {
    const listId = `LIST${i}`
    map[`TARGET${i}`] = {
      isa: 'PBXNativeTarget',
      name: target.name,
      productType: `com.apple.product-type.${target.productType}`,
      buildConfigurationList: listId,
    }
    map[listId] = { isa: 'XCConfigurationList', buildConfigurations: target.configIds }
  })
  return map as Record<string, { isa?: string; productType?: string; buildConfigurationList?: string; buildConfigurations?: string[] }>
}

// Object ids in a real pbxproj are 24 hex digits, which is what the rewriter
// anchors on — these stay legal while remaining readable at a glance.
const APP_DEBUG = 'AAAAAAAAAAAAAAAAAAAAAAA1'
const APP_RELEASE = 'AAAAAAAAAAAAAAAAAAAAAAA2'
const EXT_DEBUG = 'EEEEEEEEEEEEEEEEEEEEEEE1'
const EXT_RELEASE = 'EEEEEEEEEEEEEEEEEEEEEEE2'
const UNRELATED = 'CCCCCCCCCCCCCCCCCCCCCCC1'

/**
 * A pbxproj fragment carrying the XCBuildConfiguration blocks those ids name.
 * Quoting follows the same rule the converter uses — bare when the id has no
 * special characters — so a rewrite that changes nothing is byte-identical.
 */
function pbxproj(configs: { id: string; name: string; bundleId: string }[]): string {
  const write = (id: string) => (/^[A-Za-z0-9._]+$/.test(id) ? id : `"${id}"`)
  return [
    '/* Begin XCBuildConfiguration section */',
    ...configs.flatMap((c) => [
      `\t\t${c.id} /* ${c.name} */ = {`,
      `\t\t\tisa = XCBuildConfiguration;`,
      `\t\t\tbuildSettings = {`,
      `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${write(c.bundleId)};`,
      `\t\t\t\tSWIFT_VERSION = 5.0;`,
      `\t\t\t};`,
      `\t\t\tname = ${c.name};`,
      `\t\t};`,
    ]),
    '/* End XCBuildConfiguration section */',
  ].join('\n')
}

const idsInFile = (content: string) => [...content.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ("[^"]*"|[^;]+);/g)].map((m) => m[1]!.replace(/"/g, ''))

describe('resolveBundleIds', () => {
  // The bug this replaced: converting gmail-notifier with --macos-only, the
  // converter named the *app* after the project
  // (com.rxliuli.Inbox-Notifier-for-Gmail) and handed the extension the raw
  // --bundle-identifier with no suffix. Xcode then refuses to build:
  // "Embedded binary's bundle identifier is not prefixed with the parent app's".
  it('gives the app the configured id and its extension a prefixed one', () => {
    const desired = resolveBundleIds(
      objects([
        { name: 'Inbox Notifier for Gmail', productType: 'application', configIds: ['APP_DEBUG', 'APP_RELEASE'] },
        { name: 'Inbox Notifier for Gmail Extension', productType: 'app-extension', configIds: ['EXT_DEBUG', 'EXT_RELEASE'] },
      ]),
      'com.rxliuli.gmail-notifier',
    )
    expect(Object.fromEntries(desired)).toEqual({
      APP_DEBUG: 'com.rxliuli.gmail-notifier',
      APP_RELEASE: 'com.rxliuli.gmail-notifier',
      EXT_DEBUG: 'com.rxliuli.gmail-notifier.Extension',
      EXT_RELEASE: 'com.rxliuli.gmail-notifier.Extension',
    })
  })

  it('gives both platforms of a macOS+iOS project the same pair of ids', () => {
    const desired = resolveBundleIds(
      objects([
        { name: 'App (macOS)', productType: 'application', configIds: ['MAC_D', 'MAC_R'] },
        { name: 'App (iOS)', productType: 'application', configIds: ['IOS_D', 'IOS_R'] },
        { name: 'App Extension (macOS)', productType: 'app-extension', configIds: ['MACEXT_D', 'MACEXT_R'] },
        { name: 'App Extension (iOS)', productType: 'app-extension', configIds: ['IOSEXT_D', 'IOSEXT_R'] },
      ]),
      'com.example.app',
    )
    expect(desired.get('MAC_D')).toBe('com.example.app')
    expect(desired.get('IOS_D')).toBe('com.example.app')
    expect(desired.get('MACEXT_D')).toBe('com.example.app.Extension')
    expect(desired.get('IOSEXT_D')).toBe('com.example.app.Extension')
  })

  it('ignores targets that are neither an app nor an app extension', () => {
    const desired = resolveBundleIds(
      objects([
        { name: 'App', productType: 'application', configIds: ['APP_D', 'APP_R'] },
        { name: 'AppTests', productType: 'bundle.unit-test', configIds: ['TEST_D', 'TEST_R'] },
      ]),
      'com.example.app',
    )
    expect([...desired.keys()].sort()).toEqual(['APP_D', 'APP_R'])
  })

  it('resolves nothing from an empty or unrecognised objects map', () => {
    expect(resolveBundleIds({}, 'com.example.app').size).toBe(0)
    expect(resolveBundleIds({ X: { isa: 'PBXGroup' } }, 'com.example.app').size).toBe(0)
  })

  it('skips a target whose configuration list is missing', () => {
    const broken = { T: { isa: 'PBXNativeTarget', productType: 'com.apple.product-type.application', buildConfigurationList: 'GONE' } }
    expect(resolveBundleIds(broken, 'com.example.app').size).toBe(0)
  })
})

describe('applyBundleIds', () => {
  it('rewrites only the configurations it was given', () => {
    const content = pbxproj([
      { id: APP_DEBUG, name: 'Debug', bundleId: 'com.rxliuli.Inbox-Notifier-for-Gmail' },
      { id: EXT_DEBUG, name: 'Debug', bundleId: 'com.rxliuli.gmail-notifier' },
      { id: UNRELATED, name: 'Debug', bundleId: 'com.unrelated.thing' },
    ])
    const result = applyBundleIds(
      content,
      new Map([
        [APP_DEBUG, 'com.rxliuli.gmail-notifier'],
        [EXT_DEBUG, 'com.rxliuli.gmail-notifier.Extension'],
      ]),
    )
    expect(idsInFile(result)).toEqual(['com.rxliuli.gmail-notifier', 'com.rxliuli.gmail-notifier.Extension', 'com.unrelated.thing'])
  })

  it('leaves everything else in the block alone', () => {
    const content = pbxproj([{ id: APP_DEBUG, name: 'Debug', bundleId: 'com.old' }])
    const result = applyBundleIds(content, new Map([[APP_DEBUG, 'com.new']]))
    expect(result).toContain('SWIFT_VERSION = 5.0;')
    expect(result).toContain('name = Debug;')
  })

  it('leaves a bare (no special characters) replacement id unquoted', () => {
    const content = pbxproj([{ id: APP_DEBUG, name: 'Debug', bundleId: 'com.example.MyExt' }])
    const result = applyBundleIds(content, new Map([[APP_DEBUG, 'com.example.myext']]))
    expect(result).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.example.myext;')
  })

  // Every safari build re-runs this over a freshly converted project, and most
  // of those are already correct — a second pass must not drift.
  it('is idempotent', () => {
    const content = pbxproj([
      { id: APP_DEBUG, name: 'Debug', bundleId: 'com.example.app' },
      { id: EXT_DEBUG, name: 'Debug', bundleId: 'com.example.app.Extension' },
    ])
    const desired = new Map([
      [APP_DEBUG, 'com.example.app'],
      [EXT_DEBUG, 'com.example.app.Extension'],
    ])
    const once = applyBundleIds(content, desired)
    expect(once).toBe(content)
    expect(applyBundleIds(once, desired)).toBe(once)
  })

  // Nothing resolved means the structure didn't parse; leaving a working
  // project alone beats rewriting ids on a guess.
  it('is a no-op when nothing was resolved', () => {
    const content = pbxproj([{ id: APP_DEBUG, name: 'Debug', bundleId: 'com.old' }])
    expect(applyBundleIds(content, new Map())).toBe(content)
  })
})
