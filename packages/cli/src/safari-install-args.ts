import type { SafariPlatform } from './safari-build-args'

export interface RawSafariInstallArgs {
  source?: string
  platform: SafariPlatform
  output?: string
  /** May be `false` when citty/mri parses `--no-sign` as negated `--sign`. */
  sign?: string | boolean
  noSign?: boolean
  teamId?: string
  bundleId?: string
  device?: string
  keepProject?: string
  macosDeploymentTarget: string
  debug?: boolean
}

export interface SafariInstallOptions {
  source: string
  platform: SafariPlatform
  output?: string
  sign?: string
  noSign: boolean
  teamId?: string
  bundleId?: string
  device?: string
  keepProject?: string
  macosDeploymentTarget: string
  debug: boolean
}

const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

export function resolveSafariInstallOptions(raw: RawSafariInstallArgs): SafariInstallOptions {
  const source = raw.source?.trim()
  if (!source) {
    throw new Error(
      '<source> is required — pass a Chrome Web Store URL, 32-char extension ID, or local directory / .crx / .zip',
    )
  }

  const noSign = Boolean(raw.noSign) || raw.sign === false
  const sign = typeof raw.sign === 'string' ? raw.sign.trim() || undefined : undefined
  if (sign && noSign) {
    throw new Error('--sign and --no-sign cannot be used together')
  }

  if (raw.device && raw.platform !== 'ios') {
    throw new Error('--device is only valid with --platform ios')
  }

  if (noSign && raw.platform === 'ios' && !raw.output) {
    throw new Error(
      '--no-sign on iOS requires --output <path> (unsigned .ipa cannot be installed directly to a device)',
    )
  }

  if (raw.bundleId !== undefined && !BUNDLE_ID_RE.test(raw.bundleId)) {
    throw new Error('--bundle-id must be a reverse-DNS identifier like dev.extport.local.my-ext')
  }

  return {
    source,
    platform: raw.platform,
    output: raw.output?.trim() || undefined,
    sign,
    noSign,
    teamId: raw.teamId?.trim() || undefined,
    bundleId: raw.bundleId?.trim() || undefined,
    device: raw.device?.trim() || undefined,
    keepProject: raw.keepProject?.trim() || undefined,
    macosDeploymentTarget: raw.macosDeploymentTarget,
    debug: Boolean(raw.debug),
  }
}
