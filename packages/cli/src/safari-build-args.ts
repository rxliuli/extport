export type SafariPlatform = 'macos' | 'ios'

export interface SafariBuildOptions {
  projectPath: string
  teamId: string
  issuerId: string
  keyId: string
  keyPath?: string
  version?: string
  platform?: SafariPlatform
  macosDeploymentTarget: string
}

export const SAFARI_BUILD_USAGE = `extport safari-build — build, sign, and upload a Safari web extension to App Store Connect

This never submits for review — extport's reconcile loop does that once it
observes the processed build. Run on the Mac (or macOS CI runner) that has
the project's signing certificate in its keychain.

Usage:
  extport safari-build --project-path <dir> --team-id <TEAMID> [options]

Options:
  --project-path <dir>            Directory containing the .xcodeproj (required —
                                    or extport.config.json's "safari.projectPath")
  --team-id <TEAMID>               Apple Developer Team ID (required, or config)
  --issuer-id <id>                 App Store Connect issuer id (or env ASC_ISSUER_ID, or config)
  --key-id <id>                    App Store Connect key id (or env ASC_KEY_ID, or config)
  --key-path <path>                .p8 key file (or env ASC_KEY_PATH; defaults to Apple's
                                    own tooling search order: ./private_keys,
                                    ~/private_keys, ~/.private_keys, then
                                    ~/.appstoreconnect/private_keys — all as
                                    AuthKey_<key-id>.p8)
  --platform <macos|ios>            Build only one platform (default: every platform
                                    the Xcode project ships)
  --version <x.y.z>                 Fail loudly if the built app's version doesn't
                                    match (safety net — extport never stamps it)
  --macos-deployment-target <ver>   Default: 12.0

Missing required fields prompt for them interactively in a terminal;
non-interactive runs (CI) fail immediately instead. Run "extport init" to
generate extport.config.json's "safari" block once, up front.
`

const PLATFORMS = ['macos', 'ios']

/** Falls back to extport.config.json's `safari` block. */
export interface SafariBuildDefaults {
  projectPath?: string
  teamId?: string
  issuerId?: string
  keyId?: string
}

export function parseSafariBuildArgs(
  argv: string[],
  env: Record<string, string | undefined>,
  defaults: SafariBuildDefaults = {},
): SafariBuildOptions {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) break
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`flag ${arg} requires a value`)
    flags[arg.slice(2)] = value
    i++
  }

  const projectPath = flags['project-path'] ?? defaults.projectPath
  if (!projectPath) throw new Error('--project-path is required')
  const teamId = flags['team-id'] ?? defaults.teamId
  if (!teamId) throw new Error('--team-id is required')

  const issuerId = flags['issuer-id'] ?? env.ASC_ISSUER_ID ?? defaults.issuerId
  if (!issuerId) throw new Error('missing App Store Connect issuer id: set ASC_ISSUER_ID or pass --issuer-id')
  const keyId = flags['key-id'] ?? env.ASC_KEY_ID ?? defaults.keyId
  if (!keyId) throw new Error('missing App Store Connect key id: set ASC_KEY_ID or pass --key-id')
  const keyPath = flags['key-path'] ?? env.ASC_KEY_PATH

  const version = flags['version']
  if (version !== undefined && !/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Error('--version must be 1-4 dot-separated integers')
  }

  const platform = flags['platform'] as SafariPlatform | undefined
  if (platform !== undefined && !PLATFORMS.includes(platform)) {
    throw new Error(`--platform must be one of: ${PLATFORMS.join(', ')}`)
  }

  const macosDeploymentTarget = flags['macos-deployment-target'] ?? '12.0'

  return { projectPath, teamId, issuerId, keyId, keyPath, version, platform, macosDeploymentTarget }
}
