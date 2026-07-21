import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveArgs,
  authArgs,
  builtInfoPlistPath,
  detectPlatforms,
  exportArgs,
  exportOptionsPlist,
  resolveKeyPath,
  runSafariBuild,
} from '../src/safari-build.mjs'

describe('detectPlatforms', () => {
  it('detects both platforms from suffixed schemes', () => {
    expect(detectPlatforms(['Scrub (macOS)', 'Scrub (iOS)'], 'Scrub')).toEqual({ macos: 'Scrub (macOS)', ios: 'Scrub (iOS)' })
  })

  it('detects a single platform', () => {
    expect(detectPlatforms(['Scrub (macOS)'], 'Scrub')).toEqual({ macos: 'Scrub (macOS)', ios: undefined })
    expect(detectPlatforms(['Scrub (iOS)'], 'Scrub')).toEqual({ macos: undefined, ios: 'Scrub (iOS)' })
  })

  it('treats an unsuffixed scheme matching the project name as a single macOS platform', () => {
    expect(detectPlatforms(['Scrub'], 'Scrub')).toEqual({ macos: 'Scrub', ios: undefined })
  })

  it('throws when nothing matches, listing the available schemes', () => {
    expect(() => detectPlatforms(['SomeOtherScheme'], 'Scrub')).toThrow(/SomeOtherScheme/)
  })
})

describe('resolveKeyPath', () => {
  const home = '/Users/tenant'

  it('an explicit keyPath always wins', () => {
    expect(resolveKeyPath({ keyId: 'K1', keyPath: '/custom/key.p8' }, home, () => false)).toBe('/custom/key.p8')
  })

  it('prefers ~/.appstoreconnect/private_keys over ~/private_keys', () => {
    const found = resolveKeyPath({ keyId: 'K1' }, home, () => true)
    expect(found).toBe(join(home, '.appstoreconnect', 'private_keys', 'AuthKey_K1.p8'))
  })

  it('falls back to ~/private_keys when the first candidate is absent', () => {
    const legacy = join(home, 'private_keys', 'AuthKey_K1.p8')
    const found = resolveKeyPath({ keyId: 'K1' }, home, (p) => p === legacy)
    expect(found).toBe(legacy)
  })

  it('throws with guidance when neither candidate exists', () => {
    expect(() => resolveKeyPath({ keyId: 'K1' }, home, () => false)).toThrow(/--key-path or set ASC_KEY_PATH/)
  })
})

describe('archiveArgs / exportArgs / authArgs / exportOptionsPlist', () => {
  const auth = authArgs({ keyId: 'KEY1', issuerId: 'iss-1', keyPath: '/k.p8' })

  it('builds auth flags from the API key', () => {
    expect(auth).toEqual(['-authenticationKeyID', 'KEY1', '-authenticationKeyIssuerID', 'iss-1', '-authenticationKeyPath', '/k.p8'])
  })

  it('archives with automatic signing — no certificate or profile files', () => {
    const args = archiveArgs(
      { xcodeprojPath: '/p/Scrub.xcodeproj', scheme: 'Scrub (macOS)', archivePath: '/tmp/macos.xcarchive', teamId: 'TEAM1', macosDeploymentTarget: '12.0' },
      'macos',
      auth,
    )
    expect(args).toEqual([
      '-project',
      '/p/Scrub.xcodeproj',
      '-scheme',
      'Scrub (macOS)',
      '-configuration',
      'Release',
      '-archivePath',
      '/tmp/macos.xcarchive',
      'archive',
      '-allowProvisioningUpdates',
      '-authenticationKeyID',
      'KEY1',
      '-authenticationKeyIssuerID',
      'iss-1',
      '-authenticationKeyPath',
      '/k.p8',
      'DEVELOPMENT_TEAM=TEAM1',
      'CODE_SIGN_STYLE=Automatic',
      'MACOSX_DEPLOYMENT_TARGET=12.0',
      'ARCHS=x86_64 arm64',
      'ONLY_ACTIVE_ARCH=NO',
    ])
  })

  it('archives an iOS scheme with the iphoneos SDK instead of a deployment target', () => {
    const args = archiveArgs(
      { xcodeprojPath: '/p/Scrub.xcodeproj', scheme: 'Scrub (iOS)', archivePath: '/tmp/ios.xcarchive', teamId: 'TEAM1', macosDeploymentTarget: '12.0' },
      'ios',
      auth,
    )
    expect(args.slice(-2)).toEqual(['-sdk', 'iphoneos'])
    expect(args).not.toContain('MACOSX_DEPLOYMENT_TARGET=12.0')
  })

  it('exports with destination:upload — no separate altool step', () => {
    const args = exportArgs({ archivePath: '/tmp/macos.xcarchive', exportOptionsPath: '/tmp/opts.plist', exportPath: '/tmp/export' }, auth)
    expect(args).toEqual([
      '-exportArchive',
      '-archivePath',
      '/tmp/macos.xcarchive',
      '-exportOptionsPlist',
      '/tmp/opts.plist',
      '-exportPath',
      '/tmp/export',
      '-allowProvisioningUpdates',
      '-authenticationKeyID',
      'KEY1',
      '-authenticationKeyIssuerID',
      'iss-1',
      '-authenticationKeyPath',
      '/k.p8',
    ])
  })

  it('the export options plist requests automatic signing and an upload destination', () => {
    const plist = exportOptionsPlist('TEAM1')
    expect(plist).toContain('<string>app-store</string>')
    expect(plist).toContain('<string>TEAM1</string>')
    expect(plist).toContain('<string>automatic</string>')
    expect(plist).toContain('<string>upload</string>')
  })
})

describe('builtInfoPlistPath', () => {
  it('macOS nests Info.plist under Contents', () => {
    expect(builtInfoPlistPath('/a.xcarchive', 'Scrub', 'macos')).toBe('/a.xcarchive/Products/Applications/Scrub.app/Contents/Info.plist')
  })

  it('iOS has no Contents directory', () => {
    expect(builtInfoPlistPath('/a.xcarchive', 'Scrub', 'ios')).toBe('/a.xcarchive/Products/Applications/Scrub.app/Info.plist')
  })
})

describe('runSafariBuild', () => {
  let projectDir: string
  afterEach(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true })
  })

  async function makeProject(xcodeprojName: string) {
    projectDir = await mkdtemp(join(tmpdir(), 'extport-safari-build-test-'))
    await mkdir(join(projectDir, xcodeprojName))
    return projectDir
  }

  const baseOptions = {
    teamId: 'TEAM1',
    issuerId: 'iss-1',
    keyId: 'KEY1',
    keyPath: '/k.p8',
    macosDeploymentTarget: '12.0',
  }

  function fakeExec(responses: Record<string, { status: number; stdout?: string }>) {
    const calls: { cmd: string; args: string[] }[] = []
    const exec = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args })
      for (const [key, res] of Object.entries(responses)) {
        if (args.includes(key) || cmd === key) return { stdout: res.stdout ?? '', status: res.status }
      }
      throw new Error(`no fake response for ${cmd} ${args.join(' ')}`)
    }
    return { exec, calls }
  }

  it('builds and uploads both platforms detected from the schemes', async () => {
    const dir = await makeProject('Scrub.xcodeproj')
    const { exec, calls } = fakeExec({
      '-list': { status: 0, stdout: JSON.stringify({ project: { schemes: ['Scrub (macOS)', 'Scrub (iOS)'] } }) },
      archive: { status: 0 },
      '-exportArchive': { status: 0 },
    })

    const results = await runSafariBuild({ projectPath: dir, ...baseOptions }, exec, { log: () => {}, homedir: '/h', exists: () => true })

    expect(results).toEqual([
      { platform: 'macos', ok: true },
      { platform: 'ios', ok: true },
    ])
    // list, then macos archive+export, then ios archive+export.
    expect(calls.map((c) => c.args[0])).toEqual(['-project', '-project', '-exportArchive', '-project', '-exportArchive'])
    const macosArchive = calls[1]!
    expect(macosArchive.args).toContain('Scrub (macOS)')
    expect(macosArchive.args).toContain('DEVELOPMENT_TEAM=TEAM1')
    const iosArchive = calls[3]!
    expect(iosArchive.args).toContain('Scrub (iOS)')
    expect(iosArchive.args).toContain('-sdk')
  })

  it('restricts to a single --platform when requested', async () => {
    const dir = await makeProject('Scrub.xcodeproj')
    const { exec, calls } = fakeExec({
      '-list': { status: 0, stdout: JSON.stringify({ project: { schemes: ['Scrub (macOS)', 'Scrub (iOS)'] } }) },
      archive: { status: 0 },
      '-exportArchive': { status: 0 },
    })

    const results = await runSafariBuild({ projectPath: dir, ...baseOptions, platform: 'macos' }, exec, { log: () => {}, homedir: '/h', exists: () => true })

    expect(results).toEqual([{ platform: 'macos', ok: true }])
    expect(calls.some((c) => c.args.includes('Scrub (iOS)'))).toBe(false)
  })

  it('throws when --platform requests a platform the project does not ship', async () => {
    const dir = await makeProject('Scrub.xcodeproj')
    const { exec } = fakeExec({ '-list': { status: 0, stdout: JSON.stringify({ project: { schemes: ['Scrub (macOS)'] } }) } })

    await expect(runSafariBuild({ projectPath: dir, ...baseOptions, platform: 'ios' }, exec, { homedir: '/h', exists: () => true, log: () => {} })).rejects.toThrow(
      /no ios scheme/,
    )
  })

  it('one platform failing does not stop its sibling', async () => {
    const dir = await makeProject('Scrub.xcodeproj')
    let macosCalls = 0
    const exec = async (cmd: string, args: string[]) => {
      if (args.includes('-list')) return { stdout: JSON.stringify({ project: { schemes: ['Scrub (macOS)', 'Scrub (iOS)'] } }), status: 0 }
      if (args.includes('archive')) {
        if (args.includes('Scrub (macOS)')) {
          macosCalls++
          return { stdout: '', status: 1 } // macOS archive fails
        }
        return { stdout: '', status: 0 } // iOS archive succeeds
      }
      if (args.includes('-exportArchive')) return { stdout: '', status: 0 }
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`)
    }

    const results = await runSafariBuild({ projectPath: dir, ...baseOptions }, exec, { log: () => {}, homedir: '/h', exists: () => true })

    expect(macosCalls).toBe(1)
    expect(results).toEqual([
      { platform: 'macos', ok: false, error: 'xcodebuild archive failed' },
      { platform: 'ios', ok: true },
    ])
  })

  it('fails a platform whose built version does not match --version, without attempting to export', async () => {
    const dir = await makeProject('Scrub.xcodeproj')
    let exportCalled = false
    const exec = async (cmd: string, args: string[]) => {
      if (args.includes('-list')) return { stdout: JSON.stringify({ project: { schemes: ['Scrub (macOS)'] } }), status: 0 }
      if (args.includes('archive')) return { stdout: '', status: 0 }
      if (cmd === '/usr/libexec/PlistBuddy') return { stdout: '0.0.6\n', status: 0 }
      if (args.includes('-exportArchive')) {
        exportCalled = true
        return { stdout: '', status: 0 }
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`)
    }

    const results = await runSafariBuild({ projectPath: dir, ...baseOptions, version: '0.0.7' }, exec, { log: () => {}, homedir: '/h', exists: () => true })

    expect(exportCalled).toBe(false)
    expect(results).toEqual([{ platform: 'macos', ok: false, error: expect.stringContaining('does not match --version 0.0.7') }])
  })

  it('throws when the project directory has no .xcodeproj', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'extport-safari-build-test-'))
    const { exec } = fakeExec({})
    await expect(runSafariBuild({ projectPath: projectDir, ...baseOptions }, exec, { homedir: '/h', exists: () => true, log: () => {} })).rejects.toThrow(
      /no \.xcodeproj found/,
    )
  })

  it('throws when xcodebuild -list fails', async () => {
    const dir = await makeProject('Scrub.xcodeproj')
    const { exec } = fakeExec({ '-list': { status: 1 } })
    await expect(runSafariBuild({ projectPath: dir, ...baseOptions }, exec, { homedir: '/h', exists: () => true, log: () => {} })).rejects.toThrow(/xcodebuild -list failed/)
  })
})
