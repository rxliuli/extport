import { convertExtensionToXcodeProject, type ConvertedXcodeProject } from '@extport/safari-xcode'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec, ExecResult } from './exec'
import type { SafariPlatform } from './safari-build-args'
import type { SafariInstallOptions } from './safari-install-args'
import { discoverIosDevices, selectIosDevice, type IosDevice } from './safari-install-devices'
import { patchExtensionForSafari } from './safari-install-compat'
import { buildDeterministicBundleId, inspectExtensionManifest } from './safari-install-manifest'
import {
  discoverSigningIdentities,
  selectSigningIdentity,
  type SigningIdentity,
  type SigningSelection,
} from './safari-install-signing'
import { resolveExtensionSource } from './safari-install-source'

const DEFAULT_APP_CATEGORY = 'public.app-category.utilities'

export function buildInstallXcodebuildArgs(opts: {
  xcodeprojPath: string
  scheme: string
  derivedDataPath: string
  platform: SafariPlatform
  signing: SigningSelection
  macosDeploymentTarget: string
}): string[] {
  const args = [
    '-project',
    opts.xcodeprojPath,
    '-scheme',
    opts.scheme,
    '-configuration',
    'Release',
    '-derivedDataPath',
    opts.derivedDataPath,
    'build',
  ]

  if (opts.platform === 'macos') {
    args.push(`MACOSX_DEPLOYMENT_TARGET=${opts.macosDeploymentTarget}`, 'ONLY_ACTIVE_ARCH=YES')
    if (opts.signing.mode === 'identity') {
      if (opts.signing.identity.kind === 'developer-id-application') {
        // Automatic signing defaults to Apple Development on plain `build`;
        // force Manual with the chosen Developer ID identity so the bundle
        // actually carries that signature.
        args.push(
          'CODE_SIGN_STYLE=Manual',
          `CODE_SIGN_IDENTITY=${opts.signing.identity.sha1}`,
          `DEVELOPMENT_TEAM=${opts.signing.teamId}`,
          'PROVISIONING_PROFILE_SPECIFIER=',
          'CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO',
        )
      } else {
        args.push('-allowProvisioningUpdates', 'CODE_SIGN_STYLE=Automatic', `DEVELOPMENT_TEAM=${opts.signing.teamId}`)
      }
    } else {
      args.push(
        'CODE_SIGN_STYLE=Manual',
        'CODE_SIGN_IDENTITY=-',
        'CODE_SIGNING_REQUIRED=NO',
        'AD_HOC_CODE_SIGNING_ALLOWED=YES',
      )
    }
  } else {
    args.push('-sdk', 'iphoneos')
    if (opts.signing.mode === 'identity') {
      args.push('-allowProvisioningUpdates', 'CODE_SIGN_STYLE=Automatic', `DEVELOPMENT_TEAM=${opts.signing.teamId}`)
    } else {
      args.push('CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=')
    }
  }

  return args
}

export function resolveInstallScheme(schemes: string[], projectName: string, platform: SafariPlatform): string {
  const suffixed = `${projectName} (${platform === 'macos' ? 'macOS' : 'iOS'})`
  if (schemes.includes(suffixed)) return suffixed
  if (schemes.includes(projectName)) return projectName
  throw new Error(`generated project has no ${platform} scheme (found: ${schemes.join(', ') || '(none)'})`)
}

export function resolveExportPath(output: string, appName: string, ext: '.app' | '.ipa'): string {
  const resolved = path.resolve(output)
  if (resolved.toLowerCase().endsWith(ext)) return resolved
  return path.join(resolved, `${appName}${ext}`)
}

export function formatXcodebuildFailureHint(output: string, platform: SafariPlatform): string | undefined {
  if (/No Accounts|Add a new account|Account.*not signed in/i.test(output)) {
    return 'Hint: open Xcode → Settings → Apple Accounts and sign in with your Apple Account (a free Apple Account works).'
  }
  if (/There are no devices registered|No devices are registered/i.test(output)) {
    return 'Hint: connect your iPhone/iPad via USB and trust this Mac (or register it in Xcode → Window → Devices and Simulators) before building for iOS.'
  }
  if (/maximum number of App IDs|Your development team has reached the maximum number/i.test(output)) {
    return 'Hint: free Apple Accounts allow at most 3 active App IDs per 7 days, and each Safari extension uses 2 (host app + .appex). Wait for old App IDs to expire or use a paid Apple Developer account.'
  }
  if (platform === 'ios' && /requires a provisioning profile|No profiles for/i.test(output)) {
    return 'Hint: connect your iPhone via USB, make sure you are signed in to Xcode → Settings → Apple Accounts, and retry — or pass --no-sign --output <path> to export an unsigned .ipa.'
  }
  if (platform === 'ios' && /Couldn't load Info dictionary/i.test(output)) {
    return 'Hint: an extension directory name (such as Contents/, Frameworks/, PlugIns/, or Resources/) collided with a reserved iOS bundle directory inside the .appex.'
  }
  return undefined
}

async function runLogged(
  exec: Exec,
  cmd: string,
  args: string[],
  log: (msg: string) => void,
  debug: boolean,
): Promise<ExecResult> {
  const res = await exec(cmd, args, { stream: debug })
  if (res.status !== 0 && !debug) {
    if (res.stdout) log(res.stdout)
    if (res.stderr) log(res.stderr)
  }
  return res
}

async function locateBuiltApp(productsDir: string, expectedName: string): Promise<string> {
  const exact = path.join(productsDir, `${expectedName}.app`)
  if (existsSync(exact)) return exact

  const entries = await readdir(productsDir)
  const found = entries.find((entry) => entry.endsWith('.app'))
  if (!found) throw new Error(`could not find built .app in ${productsDir}`)
  return path.join(productsDir, found)
}

async function copyBundleWithDitto(exec: Exec, src: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true })
  if (existsSync(dest)) {
    await rm(dest, { recursive: true, force: true })
  }
  const res = await exec('/usr/bin/ditto', [src, dest])
  if (res.status !== 0) {
    throw new Error(`ditto failed copying ${src} to ${dest}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ''}`)
  }
}

async function packageIpa(exec: Exec, builtAppPath: string, workDir: string, destIpaPath: string): Promise<void> {
  const payloadDir = path.join(workDir, 'ipa-stage', 'Payload')
  const stagedApp = path.join(payloadDir, path.basename(builtAppPath))
  await copyBundleWithDitto(exec, builtAppPath, stagedApp)

  await mkdir(path.dirname(destIpaPath), { recursive: true })
  if (existsSync(destIpaPath)) {
    await rm(destIpaPath, { force: true })
  }
  const res = await exec('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', payloadDir, destIpaPath])
  if (res.status !== 0) {
    throw new Error(`ditto failed packaging .ipa${res.stderr.trim() ? `: ${res.stderr.trim()}` : ''}`)
  }
}

export interface SafariInstallResult {
  appName: string
  version: string
  bundleId: string
  platform: SafariPlatform
  signing: SigningSelection
  action: 'installed' | 'exported'
  outputPath?: string
  device?: IosDevice
  keptProjectPath?: string
}

export interface RunSafariInstallDeps {
  log?: (msg: string) => void
  homedir?: string
  isTTY?: boolean
  env?: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
  promptSelectIdentity?: (identities: SigningIdentity[], platform: SafariPlatform) => Promise<SigningIdentity | 'none'>
  promptSelectDevice?: (devices: IosDevice[]) => Promise<IosDevice>
  convert?: typeof convertExtensionToXcodeProject
}

export async function runSafariInstall(
  options: SafariInstallOptions,
  exec: Exec,
  deps: RunSafariInstallDeps = {},
): Promise<SafariInstallResult> {
  const log = deps.log ?? console.log
  const home = deps.homedir ?? homedir()
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY)
  const convert = deps.convert ?? convertExtensionToXcodeProject

  const workDir = await mkdtemp(path.join(tmpdir(), 'extport-safari-install-'))
  try {
    // 1. Resolve & unpack source
    const resolved = await resolveExtensionSource(options.source, workDir, {
      fetch: deps.fetch,
      env: deps.env,
      log,
    })

    // 2. Inspect manifest (MV3 enforcement, localized name, version, Safari API warnings)
    const meta = await inspectExtensionManifest(resolved.unpackedDir, resolved.fallbackName)
    log(`── extension: ${meta.appName} v${meta.version} (MV3) ──`)
    for (const warning of meta.warnings) {
      log(`⚠ ${warning.api}: ${warning.reason}`)
    }

    // 3. Discover & choose signing identity from Keychain
    const identities = options.noSign ? [] : await discoverSigningIdentities(options.platform, exec)
    const signing = await selectSigningIdentity({
      platform: options.platform,
      identities,
      signQuery: options.sign,
      noSign: options.noSign,
      teamIdOverride: options.teamId,
      hasOutput: Boolean(options.output),
      isTTY,
      promptSelect: deps.promptSelectIdentity,
    })

    const teamId = signing.mode === 'identity' ? signing.teamId : undefined
    if (signing.mode === 'identity') {
      log(`── signing: ${signing.identity.name} (Team ${signing.teamId}) ──`)
    } else if (signing.mode === 'adhoc') {
      log(
        `── signing: ad-hoc (${signing.reason === 'fallback' ? 'no matching certificate in Keychain' : '--no-sign'}) ──`,
      )
    } else {
      log(
        `── signing: unsigned (${signing.reason === 'fallback' ? 'no Apple Development certificate in Keychain' : '--no-sign'}) ──`,
      )
    }

    // 3b. For direct iOS installs, discover target device before spending time converting/building
    let targetDevice: IosDevice | undefined
    if (options.platform === 'ios' && !options.output) {
      const devices = await discoverIosDevices(exec)
      targetDevice = await selectIosDevice({
        devices,
        query: options.device,
        isTTY,
        promptSelect: deps.promptSelectDevice,
      })
      log(`── device: ${targetDevice.name}${targetDevice.osVersion ? ` (iOS ${targetDevice.osVersion})` : ''} ──`)
    }

    // 4. Stage a working copy (when given a local directory) and patch popup/options HTML for Safari
    const relToWork = path.relative(workDir, resolved.unpackedDir)
    const isInsideWorkDir = relToWork !== '' && !relToWork.startsWith('..') && !path.isAbsolute(relToWork)
    let convertSourceDir = resolved.unpackedDir
    if (!isInsideWorkDir) {
      convertSourceDir = path.join(workDir, 'staged')
      await copyBundleWithDitto(exec, resolved.unpackedDir, convertSourceDir)
    }

    const patchedPages = await patchExtensionForSafari(convertSourceDir, options.platform)
    if (patchedPages.length > 0) {
      log(`── patched Safari layout & color-scheme: ${patchedPages.join(', ')} ──`)
    }

    // 5. Convert extension → patched Xcode project
    const bundleId =
      options.bundleId ?? buildDeterministicBundleId({ cwsId: resolved.cwsId, appName: meta.appName, teamId })
    const xcodeOutputDir = path.join(workDir, 'xcode')
    await mkdir(xcodeOutputDir, { recursive: true })
    log(`── converting to Safari ${options.platform} Xcode project (${bundleId}) ──`)
    const converted: ConvertedXcodeProject = await convert({
      sourceDir: convertSourceDir,
      outputDir: xcodeOutputDir,
      projectName: meta.appName,
      appName: meta.appName,
      version: meta.version,
      appCategory: DEFAULT_APP_CATEGORY,
      bundleIdentifier: bundleId,
      developmentTeam: teamId,
      projectType: options.platform,
      openProject: false,
      copyResources: true,
      stream: options.debug,
      log,
    })

    let keptProjectPath: string | undefined
    if (options.keepProject) {
      keptProjectPath = path.resolve(options.keepProject)
      await copyBundleWithDitto(exec, converted.projectDir, keptProjectPath)
      log(`── kept Xcode project at ${keptProjectPath} ──`)
    }

    // 5. Discover scheme and build with xcodebuild
    const listRes = await runLogged(
      exec,
      'xcodebuild',
      ['-project', converted.xcodeprojPath, '-list', '-json'],
      log,
      options.debug,
    )
    if (listRes.status !== 0) {
      throw new Error(`xcodebuild -list failed for ${converted.xcodeprojPath}`)
    }
    const listJson = JSON.parse(listRes.stdout) as { project: { schemes: string[] } }
    const scheme = resolveInstallScheme(listJson.project.schemes, converted.projectName, options.platform)

    const derivedDataPath = path.join(workDir, 'DerivedData')
    log(`── building "${scheme}" ──`)
    const buildArgs = buildInstallXcodebuildArgs({
      xcodeprojPath: converted.xcodeprojPath,
      scheme,
      derivedDataPath,
      platform: options.platform,
      signing,
      macosDeploymentTarget: options.macosDeploymentTarget,
    })
    const buildRes = await runLogged(exec, 'xcodebuild', buildArgs, log, options.debug)
    if (buildRes.status !== 0) {
      const hint = formatXcodebuildFailureHint(`${buildRes.stdout}\n${buildRes.stderr}`, options.platform)
      throw new Error(`xcodebuild failed${hint ? `\n${hint}` : ''}`)
    }

    const productsDir =
      options.platform === 'macos'
        ? path.join(derivedDataPath, 'Build', 'Products', 'Release')
        : path.join(derivedDataPath, 'Build', 'Products', 'Release-iphoneos')
    const builtAppPath = await locateBuiltApp(productsDir, converted.projectName)

    // 6. Export OR install
    if (options.output) {
      if (options.platform === 'macos') {
        const destApp = resolveExportPath(options.output, converted.projectName, '.app')
        await copyBundleWithDitto(exec, builtAppPath, destApp)
        log(`✅ Exported macOS app to ${destApp}`)
        if (signing.mode === 'adhoc') {
          log(
            'Note: ad-hoc signed — enable Safari → Settings → Advanced → Show features for web developers, then Safari → Settings → Developer → Allow unsigned extensions (or sign in to Xcode → Settings → Apple Accounts with a free Apple Account to sign locally).',
          )
        }
        return {
          appName: converted.projectName,
          version: meta.version,
          bundleId,
          platform: options.platform,
          signing,
          action: 'exported',
          outputPath: destApp,
          keptProjectPath,
        }
      }

      const destIpa = resolveExportPath(options.output, converted.projectName, '.ipa')
      await packageIpa(exec, builtAppPath, workDir, destIpa)
      log(`✅ Exported iOS archive to ${destIpa}`)
      if (signing.mode === 'unsigned') {
        log(
          'Note: unsigned .ipa — sideload and re-sign with AltStore / SideStore / Sideloadly (a Safari extension uses 2 App IDs: host app + .appex).',
        )
      }
      return {
        appName: converted.projectName,
        version: meta.version,
        bundleId,
        platform: options.platform,
        signing,
        action: 'exported',
        outputPath: destIpa,
        keptProjectPath,
      }
    }

    if (options.platform === 'macos') {
      const destApp = path.join(home, 'Applications', `${converted.projectName}.app`)
      log(`── installing to ${destApp} ──`)
      await copyBundleWithDitto(exec, builtAppPath, destApp)

      const openRes = await exec('open', [destApp])
      if (openRes.status !== 0) {
        log(
          `⚠ could not launch ${destApp} automatically — open it once in Finder to register the extension with Safari`,
        )
      }

      log(`✅ Installed "${converted.projectName}" to ${destApp}`)
      log('Next: enable the extension in Safari → Settings → Extensions.')
      if (signing.mode === 'adhoc') {
        log(
          'Note: ad-hoc signed — enable Safari → Settings → Advanced → Show features for web developers, then check Safari → Settings → Developer → Allow unsigned extensions (resets on Safari restart). Signing in to Xcode → Settings → Apple Accounts avoids this.',
        )
      }
      return {
        appName: converted.projectName,
        version: meta.version,
        bundleId,
        platform: options.platform,
        signing,
        action: 'installed',
        outputPath: destApp,
        keptProjectPath,
      }
    }

    // Direct iOS install via devicectl
    log(`── installing onto "${targetDevice!.name}" ──`)
    const installRes = await runLogged(
      exec,
      'xcrun',
      ['devicectl', 'device', 'install', 'app', '--device', targetDevice!.identifier, builtAppPath],
      log,
      options.debug,
    )
    if (installRes.status !== 0) {
      throw new Error(`xcrun devicectl device install app failed for "${targetDevice!.name}"`)
    }

    log(`✅ Installed "${converted.projectName}" onto ${targetDevice!.name}`)
    log('Next on your device: Settings → Apps → Safari → Extensions → enable the extension.')
    log(
      'Note: apps signed with a free Apple ID expire after 7 days and use 2 of your 3 App ID slots (host app + .appex).',
    )
    return {
      appName: converted.projectName,
      version: meta.version,
      bundleId,
      platform: options.platform,
      signing,
      action: 'installed',
      device: targetDevice,
      keptProjectPath,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
