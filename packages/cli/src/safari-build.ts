import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from './exec.js'
import type { SafariBuildOptions, SafariPlatform } from './safari-build-args.js'

const PLATFORMS = ['macos', 'ios'] as const satisfies readonly SafariPlatform[]

/**
 * Reads the Xcode project's own scheme list to find out which platforms it
 * actually ships — platform is an observed fact, never something the tenant
 * configures (docs/safari-pipeline.md §8). Mirrors the detection
 * safari-webext-publish-action already uses: a "(macOS)"/"(iOS)" suffixed
 * scheme per platform, or — for a single-platform project — one scheme
 * exactly matching the project name.
 */
export function detectPlatforms(schemes: string[], projectName: string): Partial<Record<SafariPlatform, string>> {
  const macos = schemes.includes(`${projectName} (macOS)`) ? `${projectName} (macOS)` : undefined
  const ios = schemes.includes(`${projectName} (iOS)`) ? `${projectName} (iOS)` : undefined
  if (macos || ios) return { macos, ios }
  if (schemes.includes(projectName)) return { macos: projectName }
  throw new Error(`no macOS or iOS scheme found in the project — available schemes: ${schemes.join(', ') || '(none)'}`)
}

/**
 * App Store Connect API key lookup — the same four conventional paths, in
 * the same order, that Apple's own tools (altool, xcodebuild) search when
 * given a key id without an explicit path: a key placed for one tool works
 * for this CLI without extra configuration, and vice versa.
 * https://github.com/codemagic-ci-cd/cli-tools/blob/master/docs/app-store-connect/README.md
 */
export function resolveKeyPath(opts: { keyId: string; keyPath?: string }, home: string, cwd: string, exists: (path: string) => boolean): string {
  if (opts.keyPath) return opts.keyPath
  const filename = `AuthKey_${opts.keyId}.p8`
  const candidates = [
    join(cwd, 'private_keys', filename),
    join(home, 'private_keys', filename),
    join(home, '.private_keys', filename),
    join(home, '.appstoreconnect', 'private_keys', filename),
  ]
  const found = candidates.find(exists)
  if (!found) {
    throw new Error(
      `could not find ${filename} in ./private_keys, ~/private_keys, ~/.private_keys, or ~/.appstoreconnect/private_keys — pass --key-path or set ASC_KEY_PATH`,
    )
  }
  return found
}

export function authArgs(opts: { keyId: string; issuerId: string; keyPath: string }): string[] {
  return ['-authenticationKeyID', opts.keyId, '-authenticationKeyIssuerID', opts.issuerId, '-authenticationKeyPath', opts.keyPath]
}

/**
 * Automatic signing + `-allowProvisioningUpdates` resolves the right
 * certificate from the ambient keychain and manages provisioning profiles
 * via the API key — no certificate files, profile files, or signing
 * identity strings for the tenant to supply (docs/safari-pipeline.md: "None
 * handled by the CLI"). This covers the app AND its nested Safari extension
 * .appex in one pass; Xcode resolves the whole target graph automatically.
 */
export function archiveArgs(
  opts: { xcodeprojPath: string; scheme: string; archivePath: string; teamId: string; macosDeploymentTarget: string },
  platform: SafariPlatform,
  auth: string[],
): string[] {
  const args = [
    '-project',
    opts.xcodeprojPath,
    '-scheme',
    opts.scheme,
    '-configuration',
    'Release',
    '-archivePath',
    opts.archivePath,
    'archive',
    '-allowProvisioningUpdates',
    ...auth,
    `DEVELOPMENT_TEAM=${opts.teamId}`,
    'CODE_SIGN_STYLE=Automatic',
  ]
  if (platform === 'macos') {
    args.push(`MACOSX_DEPLOYMENT_TARGET=${opts.macosDeploymentTarget}`, 'ARCHS=x86_64 arm64', 'ONLY_ACTIVE_ARCH=NO')
  } else {
    args.push('-sdk', 'iphoneos')
  }
  return args
}

/**
 * `destination: upload` is Xcode's own replacement for a separate altool
 * upload step (Apple's current guidance — altool is deprecated) — export
 * and upload happen in this single xcodebuild invocation.
 */
export function exportOptionsPlist(teamId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store</string>
	<key>teamID</key>
	<string>${teamId}</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>destination</key>
	<string>upload</string>
</dict>
</plist>
`
}

export function exportArgs(opts: { archivePath: string; exportOptionsPath: string; exportPath: string }, auth: string[]): string[] {
  return ['-exportArchive', '-archivePath', opts.archivePath, '-exportOptionsPlist', opts.exportOptionsPath, '-exportPath', opts.exportPath, '-allowProvisioningUpdates', ...auth]
}

export function builtInfoPlistPath(archivePath: string, projectName: string, platform: SafariPlatform): string {
  const appPath = join(archivePath, 'Products', 'Applications', `${projectName}.app`)
  return platform === 'macos' ? join(appPath, 'Contents', 'Info.plist') : join(appPath, 'Info.plist')
}

export type PlatformResult = { platform: SafariPlatform; ok: true } | { platform: SafariPlatform; ok: false; error: string }

export interface RunSafariBuildDeps {
  log?: (msg: string) => void
  homedir?: string
  cwd?: string
  exists?: (path: string) => boolean
}

/**
 * Builds, signs, and uploads every platform the project ships (or just the
 * one requested) — never submits for review (docs/safari-pipeline.md: that
 * stays reconcile's job, under the same queue semantics every store
 * follows). One platform failing doesn't stop its sibling.
 */
export async function runSafariBuild(options: SafariBuildOptions, exec: Exec, deps: RunSafariBuildDeps = {}): Promise<PlatformResult[]> {
  const log = deps.log ?? console.log
  const home = deps.homedir ?? homedir()
  const cwd = deps.cwd ?? process.cwd()
  const exists = deps.exists ?? existsSync

  const entries = await readdir(options.projectPath)
  const xcodeprojName = entries.find((e) => e.endsWith('.xcodeproj'))
  if (!xcodeprojName) throw new Error(`no .xcodeproj found in ${options.projectPath}`)
  const projectName = xcodeprojName.slice(0, -'.xcodeproj'.length)
  const xcodeprojPath = join(options.projectPath, xcodeprojName)

  const listRes = await exec('xcodebuild', ['-project', xcodeprojPath, '-list', '-json'])
  if (listRes.status !== 0) throw new Error(`xcodebuild -list failed for ${xcodeprojPath}`)
  const listJson = JSON.parse(listRes.stdout) as { project: { schemes: string[] } }
  const schemes = detectPlatforms(listJson.project.schemes, projectName)

  const platforms: SafariPlatform[] = options.platform ? [options.platform] : PLATFORMS.filter((p) => schemes[p])
  if (platforms.length === 0) throw new Error('nothing to build — no platform detected and none requested')
  for (const p of platforms) {
    if (!schemes[p]) throw new Error(`--platform ${p} requested but the project has no ${p} scheme`)
  }

  const keyPath = resolveKeyPath(options, home, cwd, exists)
  const auth = authArgs({ keyId: options.keyId, issuerId: options.issuerId, keyPath })

  const workDir = await mkdtemp(join(tmpdir(), 'extport-safari-build-'))
  const results: PlatformResult[] = []
  try {
    for (const platform of platforms) {
      const scheme = schemes[platform]!
      try {
        log(`── ${platform}: archiving "${scheme}" ──`)
        const archivePath = join(workDir, `${platform}.xcarchive`)
        const archiveRes = await exec(
          'xcodebuild',
          archiveArgs({ xcodeprojPath, scheme, archivePath, teamId: options.teamId, macosDeploymentTarget: options.macosDeploymentTarget }, platform, auth),
        )
        if (archiveRes.status !== 0) throw new Error('xcodebuild archive failed')

        if (options.version) {
          const plistPath = builtInfoPlistPath(archivePath, projectName, platform)
          const versionRes = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', plistPath])
          const builtVersion = versionRes.stdout.trim()
          if (versionRes.status !== 0 || builtVersion !== options.version) {
            throw new Error(`built version "${builtVersion || '?'}" does not match --version ${options.version} — check the Xcode project's marketing version`)
          }
        }

        const exportOptionsPath = join(workDir, `${platform}-ExportOptions.plist`)
        await writeFile(exportOptionsPath, exportOptionsPlist(options.teamId))
        log(`── ${platform}: exporting and uploading to App Store Connect ──`)
        const exportRes = await exec('xcodebuild', exportArgs({ archivePath, exportOptionsPath, exportPath: join(workDir, `${platform}-export`) }, auth))
        if (exportRes.status !== 0) throw new Error('xcodebuild export/upload failed')

        log(`── ${platform}: uploaded ──`)
        results.push({ platform, ok: true })
      } catch (err) {
        results.push({ platform, ok: false, error: (err as Error).message })
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
  return results
}
