import { describe, expect, it } from 'vitest'
import type { Exec } from '../src/exec'
import { preflightXcode, XCODE_APP_STORE_URL } from '../src/safari-install-preflight'

function mockExec(handlers: Record<string, { status: number; stdout?: string; stderr?: string }>): Exec {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    const hit = handlers[key]
    if (!hit) return { status: 0, stdout: '', stderr: '' }
    return { status: hit.status, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
  }
}

describe('preflightXcode', () => {
  it('passes when full Xcode is selected, first-launch is complete, and converter exists', async () => {
    const exec = mockExec({
      'xcode-select -p': { status: 0, stdout: '/Applications/Xcode.app/Contents/Developer\n' },
      'xcodebuild -checkFirstLaunchStatus': { status: 0 },
      'xcrun --find safari-web-extension-converter': {
        status: 0,
        stdout: '/Applications/Xcode.app/Contents/Developer/usr/bin/safari-web-extension-converter\n',
      },
    })

    await expect(preflightXcode(exec, { existsSync: () => true })).resolves.toBeUndefined()
  })

  it('points to the Mac App Store when nothing is installed', async () => {
    const exec = mockExec({
      'xcode-select -p': { status: 2, stderr: 'xcode-select: error: unable to get active developer directory' },
    })

    await expect(preflightXcode(exec, { existsSync: () => false })).rejects.toThrow(XCODE_APP_STORE_URL)
  })

  it('suggests xcode-select -s when Xcode.app exists but no developer dir is active', async () => {
    const exec = mockExec({
      'xcode-select -p': { status: 2, stderr: 'unable to get active developer directory' },
    })

    await expect(preflightXcode(exec, { existsSync: () => true })).rejects.toThrow(
      /sudo xcode-select -s \/Applications\/Xcode\.app\/Contents\/Developer/,
    )
  })

  it('suggests xcode-select -s when CLT is active but Xcode.app is also installed', async () => {
    const exec = mockExec({
      'xcode-select -p': { status: 0, stdout: '/Library/Developer/CommandLineTools\n' },
    })

    await expect(preflightXcode(exec, { existsSync: () => true })).rejects.toThrow(
      /sudo xcode-select -s \/Applications\/Xcode\.app\/Contents\/Developer/,
    )
  })

  it('explains full Xcode is required when only Command Line Tools are installed', async () => {
    const exec = mockExec({
      'xcode-select -p': { status: 0, stdout: '/Library/Developer/CommandLineTools\n' },
    })

    await expect(preflightXcode(exec, { existsSync: () => false })).rejects.toThrow(/Only Xcode Command Line Tools/)
  })

  it('guides first-launch / license acceptance when xcodebuild -checkFirstLaunchStatus fails', async () => {
    const exec = mockExec({
      'xcode-select -p': { status: 0, stdout: '/Applications/Xcode.app/Contents/Developer\n' },
      'xcodebuild -checkFirstLaunchStatus': { status: 69, stderr: 'You have not agreed to the Xcode license' },
    })

    await expect(preflightXcode(exec, { existsSync: () => true })).rejects.toThrow(
      /xcodebuild -license accept && xcodebuild -runFirstLaunch/,
    )
  })

  it('reports when safari-web-extension-converter cannot be located', async () => {
    const exec = mockExec({
      'xcode-select -p': { status: 0, stdout: '/Applications/CustomDev/Developer\n' },
      'xcodebuild -checkFirstLaunchStatus': { status: 0 },
      'xcrun --find safari-web-extension-converter': { status: 72, stderr: 'unable to find utility' },
    })

    await expect(preflightXcode(exec, { existsSync: () => true })).rejects.toThrow(
      /Could not find "safari-web-extension-converter"/,
    )
  })
})
