// @ts-check
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * @typedef {(cmd: string, args: string[]) => Promise<{ stdout: string, status: number }>} Exec
 * @typedef {'macos' | 'ios'} Platform
 */

const PLATFORMS = /** @type {const} */ (['macos', 'ios'])

/**
 * Reads the Xcode project's own scheme list to find out which platforms it
 * actually ships — platform is an observed fact, never something the tenant
 * configures (docs/safari-pipeline.md §8). Mirrors the detection
 * safari-webext-publish-action already uses: a "(macOS)"/"(iOS)" suffixed
 * scheme per platform, or — for a single-platform project — one scheme
 * exactly matching the project name.
 *
 * @param {string[]} schemes
 * @param {string} projectName
 * @returns {{ macos?: string, ios?: string }}
 */
export function detectPlatforms(schemes, projectName) {
  const macos = schemes.includes(`${projectName} (macOS)`) ? `${projectName} (macOS)` : undefined
  const ios = schemes.includes(`${projectName} (iOS)`) ? `${projectName} (iOS)` : undefined
  if (macos || ios) return { macos, ios }
  if (schemes.includes(projectName)) return { macos: projectName }
  throw new Error(`no macOS or iOS scheme found in the project — available schemes: ${schemes.join(', ') || '(none)'}`)
}

/**
 * App Store Connect API key lookup, mirroring the conventional paths Apple's
 * own tools (altool, Transporter) already search — so a key placed for one
 * tool works for this CLI without extra configuration.
 *
 * @param {{ keyId: string, keyPath?: string }} opts
 * @param {string} home
 * @param {(path: string) => boolean} exists
 * @returns {string}
 */
export function resolveKeyPath(opts, home, exists) {
  if (opts.keyPath) return opts.keyPath
  const candidates = [
    join(home, '.appstoreconnect', 'private_keys', `AuthKey_${opts.keyId}.p8`),
    join(home, 'private_keys', `AuthKey_${opts.keyId}.p8`),
  ]
  const found = candidates.find(exists)
  if (!found) {
    throw new Error(
      `could not find AuthKey_${opts.keyId}.p8 in ~/.appstoreconnect/private_keys or ~/private_keys — pass --key-path or set ASC_KEY_PATH`,
    )
  }
  return found
}

/**
 * @param {{ keyId: string, issuerId: string, keyPath: string }} opts
 * @returns {string[]}
 */
export function authArgs(opts) {
  return ['-authenticationKeyID', opts.keyId, '-authenticationKeyIssuerID', opts.issuerId, '-authenticationKeyPath', opts.keyPath]
}

/**
 * Automatic signing + `-allowProvisioningUpdates` resolves the right
 * certificate from the ambient keychain and manages provisioning profiles
 * via the API key — no certificate files, profile files, or signing
 * identity strings for the tenant to supply (docs/safari-pipeline.md: "None
 * handled by the CLI"). This covers the app AND its nested Safari extension
 * .appex in one pass; Xcode resolves the whole target graph automatically.
 *
 * @param {{ xcodeprojPath: string, scheme: string, archivePath: string, teamId: string, macosDeploymentTarget: string }} opts
 * @param {Platform} platform
 * @param {string[]} auth
 * @returns {string[]}
 */
export function archiveArgs(opts, platform, auth) {
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
 *
 * @param {string} teamId
 * @returns {string}
 */
export function exportOptionsPlist(teamId) {
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

/**
 * @param {{ archivePath: string, exportOptionsPath: string, exportPath: string }} opts
 * @param {string[]} auth
 * @returns {string[]}
 */
export function exportArgs(opts, auth) {
  return ['-exportArchive', '-archivePath', opts.archivePath, '-exportOptionsPlist', opts.exportOptionsPath, '-exportPath', opts.exportPath, '-allowProvisioningUpdates', ...auth]
}

/**
 * @param {string} archivePath
 * @param {string} projectName
 * @param {Platform} platform
 * @returns {string}
 */
export function builtInfoPlistPath(archivePath, projectName, platform) {
  const appPath = join(archivePath, 'Products', 'Applications', `${projectName}.app`)
  return platform === 'macos' ? join(appPath, 'Contents', 'Info.plist') : join(appPath, 'Info.plist')
}

/**
 * @typedef {{ platform: Platform, ok: true } | { platform: Platform, ok: false, error: string }} PlatformResult
 */

/**
 * Builds, signs, and uploads every platform the project ships (or just the
 * one requested) — never submits for review (docs/safari-pipeline.md: that
 * stays reconcile's job, under the same queue semantics every store
 * follows). One platform failing doesn't stop its sibling.
 *
 * @param {import('./safari-build-args.mjs').SafariBuildOptions} options
 * @param {Exec} exec
 * @param {{ log?: (msg: string) => void, homedir?: string, exists?: (path: string) => boolean }} [deps]
 * @returns {Promise<PlatformResult[]>}
 */
export async function runSafariBuild(options, exec, deps = {}) {
  const log = deps.log ?? console.log
  const home = deps.homedir ?? homedir()
  const exists = deps.exists ?? existsSync

  const entries = await readdir(options.projectPath)
  const xcodeprojName = entries.find((e) => e.endsWith('.xcodeproj'))
  if (!xcodeprojName) throw new Error(`no .xcodeproj found in ${options.projectPath}`)
  const projectName = xcodeprojName.slice(0, -'.xcodeproj'.length)
  const xcodeprojPath = join(options.projectPath, xcodeprojName)

  const listRes = await exec('xcodebuild', ['-project', xcodeprojPath, '-list', '-json'])
  if (listRes.status !== 0) throw new Error(`xcodebuild -list failed for ${xcodeprojPath}`)
  /** @type {{ project: { schemes: string[] } }} */
  const listJson = JSON.parse(listRes.stdout)
  const schemes = detectPlatforms(listJson.project.schemes, projectName)

  const platforms = options.platform ? [options.platform] : PLATFORMS.filter((p) => schemes[p])
  if (platforms.length === 0) throw new Error('nothing to build — no platform detected and none requested')
  for (const p of platforms) {
    if (!schemes[p]) throw new Error(`--platform ${p} requested but the project has no ${p} scheme`)
  }

  const keyPath = resolveKeyPath(options, home, exists)
  const auth = authArgs({ keyId: options.keyId, issuerId: options.issuerId, keyPath })

  const workDir = await mkdtemp(join(tmpdir(), 'extport-safari-build-'))
  /** @type {PlatformResult[]} */
  const results = []
  try {
    for (const platform of platforms) {
      const scheme = /** @type {string} */ (schemes[platform])
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
        results.push({ platform, ok: false, error: /** @type {Error} */ (err).message })
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
  return results
}
