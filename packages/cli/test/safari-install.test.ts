import { describe, expect, it } from 'vitest'
import { resolveSafariInstallOptions } from '../src/safari-install-args'
import {
  buildInstallXcodebuildArgs,
  formatXcodebuildFailureHint,
  resolveExportPath,
  resolveInstallScheme,
} from '../src/safari-install'
import type { SigningIdentity } from '../src/safari-install-signing'

describe('resolveSafariInstallOptions', () => {
  it('validates flag conflicts and defaults', () => {
    expect(
      resolveSafariInstallOptions({
        source: 'hlepfoohegkhhmjieoechaddaejaokhf',
        platform: 'macos',
        macosDeploymentTarget: '12.0',
      }),
    ).toMatchObject({
      source: 'hlepfoohegkhhmjieoechaddaejaokhf',
      platform: 'macos',
      noSign: false,
      debug: false,
    })

    expect(
      resolveSafariInstallOptions({
        source: 'hlepfoohegkhhmjieoechaddaejaokhf',
        platform: 'macos',
        sign: false,
        macosDeploymentTarget: '12.0',
      }),
    ).toMatchObject({
      sign: undefined,
      noSign: true,
    })

    expect(() =>
      resolveSafariInstallOptions({
        source: 'hlepfoohegkhhmjieoechaddaejaokhf',
        platform: 'macos',
        sign: 'Apple Development',
        noSign: true,
        macosDeploymentTarget: '12.0',
      }),
    ).toThrow(/cannot be used together/)

    expect(() =>
      resolveSafariInstallOptions({
        source: 'hlepfoohegkhhmjieoechaddaejaokhf',
        platform: 'macos',
        device: 'My iPhone',
        macosDeploymentTarget: '12.0',
      }),
    ).toThrow(/--device is only valid with --platform ios/)

    expect(() =>
      resolveSafariInstallOptions({
        source: 'hlepfoohegkhhmjieoechaddaejaokhf',
        platform: 'ios',
        noSign: true,
        macosDeploymentTarget: '12.0',
      }),
    ).toThrow(/--no-sign on iOS requires --output/)
  })
})

describe('buildInstallXcodebuildArgs', () => {
  const base = {
    xcodeprojPath: '/tmp/App.xcodeproj',
    scheme: 'App',
    derivedDataPath: '/tmp/dd',
    macosDeploymentTarget: '12.0',
  }
  const devId: SigningIdentity = {
    sha1: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    name: 'Developer ID Application: Me (TEAM123456)',
    kind: 'developer-id-application',
    teamId: 'TEAM123456',
  }
  const appleDev: SigningIdentity = {
    sha1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    name: 'Apple Development: Me (PERS1)',
    kind: 'apple-development',
    teamId: 'TEAM123456',
  }

  it('uses Automatic signing for macOS Apple Development', () => {
    const args = buildInstallXcodebuildArgs({
      ...base,
      platform: 'macos',
      signing: { mode: 'identity', identity: appleDev, teamId: 'TEAM123456' },
    })
    expect(args).toContain('CODE_SIGN_STYLE=Automatic')
    expect(args).toContain('DEVELOPMENT_TEAM=TEAM123456')
    expect(args).toContain('-allowProvisioningUpdates')
  })

  it('uses Manual signing with the exact SHA-1 for macOS Developer ID Application', () => {
    const args = buildInstallXcodebuildArgs({
      ...base,
      platform: 'macos',
      signing: { mode: 'identity', identity: devId, teamId: 'TEAM123456' },
    })
    expect(args).toContain('CODE_SIGN_STYLE=Manual')
    expect(args).toContain(`CODE_SIGN_IDENTITY=${devId.sha1}`)
    expect(args).toContain('CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO')
  })

  it('uses ad-hoc signing for macOS when unsigned', () => {
    const args = buildInstallXcodebuildArgs({
      ...base,
      platform: 'macos',
      signing: { mode: 'adhoc', reason: 'fallback' },
    })
    expect(args).toContain('CODE_SIGN_IDENTITY=-')
    expect(args).toContain('AD_HOC_CODE_SIGNING_ALLOWED=YES')
  })

  it('uses iphoneos + Automatic signing for signed iOS builds and disables signing for unsigned .ipa', () => {
    const signed = buildInstallXcodebuildArgs({
      ...base,
      platform: 'ios',
      signing: { mode: 'identity', identity: appleDev, teamId: 'TEAM123456' },
    })
    expect(signed).toContain('-sdk')
    expect(signed).toContain('iphoneos')
    expect(signed).toContain('DEVELOPMENT_TEAM=TEAM123456')

    const unsigned = buildInstallXcodebuildArgs({
      ...base,
      platform: 'ios',
      signing: { mode: 'unsigned', reason: 'explicit' },
    })
    expect(unsigned).toContain('CODE_SIGNING_ALLOWED=NO')
    expect(unsigned).toContain('CODE_SIGN_IDENTITY=')
  })
})

describe('resolveExportPath & failure hints', () => {
  it('appends the bundle filename when given a directory and preserves explicit file paths', () => {
    expect(resolveExportPath('/tmp/out', 'My Ext', '.app')).toBe('/tmp/out/My Ext.app')
    expect(resolveExportPath('/tmp/out/Custom.app', 'My Ext', '.app')).toBe('/tmp/out/Custom.app')
    expect(resolveExportPath('/tmp/out', 'My Ext', '.ipa')).toBe('/tmp/out/My Ext.ipa')
    expect(resolveExportPath('/tmp/out/custom.ipa', 'My Ext', '.ipa')).toBe('/tmp/out/custom.ipa')
  })

  it('resolves both dual-platform suffixed schemes and single-platform bare schemes for macOS and iOS', () => {
    expect(resolveInstallScheme(['Refined GitHub (macOS)', 'Refined GitHub (iOS)'], 'Refined GitHub', 'ios')).toBe(
      'Refined GitHub (iOS)',
    )
    expect(resolveInstallScheme(['Refined GitHub'], 'Refined GitHub', 'ios')).toBe('Refined GitHub')
    expect(resolveInstallScheme(['Refined GitHub'], 'Refined GitHub', 'macos')).toBe('Refined GitHub')
    expect(() => resolveInstallScheme(['Other'], 'Refined GitHub', 'ios')).toThrow(/no ios scheme/)
  })

  it('returns actionable hints for common Xcode signing errors', () => {
    expect(formatXcodebuildFailureHint('error: No Accounts: Add a new account in Accounts settings.', 'ios')).toContain(
      'Xcode → Settings → Apple Accounts',
    )
    expect(formatXcodebuildFailureHint('error: There are no devices registered in your account.', 'ios')).toContain(
      'connect your iPhone',
    )
    expect(
      formatXcodebuildFailureHint('Your development team has reached the maximum number of App IDs', 'ios'),
    ).toContain('3 active App IDs')
  })
})
