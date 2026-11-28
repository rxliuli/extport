import { existsSync } from 'node:fs'
import type { Exec } from './exec'

export const XCODE_APP_STORE_URL = 'https://apps.apple.com/app/xcode/id497799835'
const DEFAULT_XCODE_DEV_DIR = '/Applications/Xcode.app/Contents/Developer'
const CLT_DIR = '/Library/Developer/CommandLineTools'

export interface XcodePreflightDeps {
  existsSync?: (filePath: string) => boolean
}

function isCommandLineToolsPath(devDir: string): boolean {
  return devDir === CLT_DIR || devDir.startsWith(`${CLT_DIR}/`)
}

/**
 * Verifies that full Xcode (not just Command Line Tools), its first-launch setup,
 * and `safari-web-extension-converter` are ready before downloading/unpacking an
 * extension. Throws a clear, actionable message for clean-Mac failure modes.
 */
export async function preflightXcode(exec: Exec, deps: XcodePreflightDeps = {}): Promise<void> {
  const pathExists = deps.existsSync ?? existsSync
  const hasDefaultXcode = pathExists(DEFAULT_XCODE_DEV_DIR)

  const selectRes = await exec('xcode-select', ['-p'])
  const devDir = selectRes.stdout.trim()

  if (selectRes.status !== 0 || !devDir) {
    if (hasDefaultXcode) {
      throw new Error(
        'Xcode is installed, but no active developer directory is selected.\n' +
          'Run this once, then retry:\n' +
          `  sudo xcode-select -s ${DEFAULT_XCODE_DEV_DIR}`,
      )
    }
    throw new Error(
      'extport port safari requires the full Xcode app (Command Line Tools alone are not enough).\n' +
        `Install Xcode from the Mac App Store:\n  ${XCODE_APP_STORE_URL}\n` +
        'After installing, open Xcode once to finish setup, then retry.',
    )
  }

  if (isCommandLineToolsPath(devDir)) {
    if (hasDefaultXcode) {
      throw new Error(
        `Active developer directory is "${devDir}" (Command Line Tools), but Xcode.app is installed.\n` +
          'Switch to Xcode by running:\n' +
          `  sudo xcode-select -s ${DEFAULT_XCODE_DEV_DIR}`,
      )
    }
    throw new Error(
      `Only Xcode Command Line Tools are installed (${devDir}), which do not include Safari Web Extension tools.\n` +
        `Install the full Xcode app from the Mac App Store:\n  ${XCODE_APP_STORE_URL}\n` +
        'After installing, open Xcode once to finish setup, then retry.',
    )
  }

  const firstLaunchRes = await exec('xcodebuild', ['-checkFirstLaunchStatus'])
  if (firstLaunchRes.status !== 0) {
    throw new Error(
      'Xcode has not finished its first-launch setup (or the Xcode license has not been accepted).\n' +
        'Open Xcode once from Applications to finish setup — or run:\n' +
        '  sudo xcodebuild -license accept && xcodebuild -runFirstLaunch\n' +
        'Tip: signing in to Xcode → Settings → Accounts with a free Apple ID lets Safari trust your extensions without enabling "Allow Unsigned Extensions".',
    )
  }

  const converterRes = await exec('xcrun', ['--find', 'safari-web-extension-converter'])
  if (converterRes.status !== 0) {
    throw new Error(
      `Could not find "safari-web-extension-converter" under "${devDir}".\n` +
        'Make sure the full Xcode app is installed and selected:\n' +
        `  sudo xcode-select -s ${DEFAULT_XCODE_DEV_DIR}`,
    )
  }
}
