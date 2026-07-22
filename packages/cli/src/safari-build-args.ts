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

/** citty's parsed shape for the `safari-build` command. */
export interface RawSafariBuildArgs {
  projectPath?: string
  teamId?: string
  issuerId?: string
  keyId?: string
  keyPath?: string
  version?: string
  platform?: SafariPlatform
  macosDeploymentTarget: string
}

/** Falls back to extport.config.json's `safari` block. */
export interface SafariBuildDefaults {
  projectPath?: string
  teamId?: string
  issuerId?: string
  keyId?: string
}

/**
 * citty's declarative `args` handles shape, --platform's enum, --help, and
 * --macos-deployment-target's default; what's left is the flag > env >
 * defaults precedence chain for the four fields that can come from
 * extport.config.json or interactive prompts, plus the version format check
 * citty's arg types can't express.
 */
export function resolveSafariBuildOptions(
  raw: RawSafariBuildArgs,
  env: Record<string, string | undefined>,
  defaults: SafariBuildDefaults = {},
): SafariBuildOptions {
  const projectPath = raw.projectPath ?? defaults.projectPath
  if (!projectPath) throw new Error('--project-path is required')
  const teamId = raw.teamId ?? defaults.teamId
  if (!teamId) throw new Error('--team-id is required')

  const issuerId = raw.issuerId ?? env.ASC_ISSUER_ID ?? defaults.issuerId
  if (!issuerId) throw new Error('missing App Store Connect issuer id: set ASC_ISSUER_ID or pass --issuer-id')
  const keyId = raw.keyId ?? env.ASC_KEY_ID ?? defaults.keyId
  if (!keyId) throw new Error('missing App Store Connect key id: set ASC_KEY_ID or pass --key-id')
  const keyPath = raw.keyPath ?? env.ASC_KEY_PATH

  if (raw.version !== undefined && !/^\d+(\.\d+){0,3}$/.test(raw.version)) {
    throw new Error('--version must be 1-4 dot-separated integers')
  }

  return { projectPath, teamId, issuerId, keyId, keyPath, version: raw.version, platform: raw.platform, macosDeploymentTarget: raw.macosDeploymentTarget }
}
