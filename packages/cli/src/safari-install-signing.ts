import type { Exec } from './exec'
import type { SafariPlatform } from './safari-build-args'

export type SigningIdentityKind = 'apple-development' | 'developer-id-application'

export interface SigningIdentity {
  sha1: string
  name: string
  kind: SigningIdentityKind
  /** Platform restriction derived from legacy cert names; undefined means both. */
  platformScope?: SafariPlatform
  /** Extracted from the certificate's X.509 Subject `OU` field (real Apple Developer Team ID). */
  teamId?: string
}

export type SigningSelection =
  | { mode: 'identity'; identity: SigningIdentity; teamId: string }
  | { mode: 'adhoc'; reason: 'explicit' | 'fallback' }
  | { mode: 'unsigned'; reason: 'explicit' | 'fallback' }

const IDENTITY_LINE_RE = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"/

export function classifyIdentity(
  name: string,
): { kind: SigningIdentityKind; platformScope?: SafariPlatform } | undefined {
  if (name.startsWith('Apple Development:')) return { kind: 'apple-development' }
  if (name.startsWith('Mac Developer:')) return { kind: 'apple-development', platformScope: 'macos' }
  if (name.startsWith('iPhone Developer:')) return { kind: 'apple-development', platformScope: 'ios' }
  if (name.startsWith('Developer ID Application:')) return { kind: 'developer-id-application', platformScope: 'macos' }
  return undefined
}

export function isIdentityUsableForPlatform(
  identity: Pick<SigningIdentity, 'kind' | 'platformScope'>,
  platform: SafariPlatform,
): boolean {
  if (identity.platformScope && identity.platformScope !== platform) return false
  if (platform === 'ios' && identity.kind !== 'apple-development') return false
  return true
}

export function parseFindIdentityOutput(stdout: string): SigningIdentity[] {
  const identities: SigningIdentity[] = []
  const seen = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(IDENTITY_LINE_RE)
    if (!match) continue
    const sha1 = match[1]!.toUpperCase()
    const name = match[2]!
    if (seen.has(sha1)) continue
    const classified = classifyIdentity(name)
    if (!classified) continue
    seen.add(sha1)
    identities.push({ sha1, name, ...classified })
  }
  return identities
}

/**
 * Parses `security find-certificate -a -Z -p` output into a SHA-1 → PEM map so
 * duplicate certificate Common Names still map deterministically to the exact
 * certificate reported by `security find-identity`.
 */
export function parseCertPemBlocks(stdout: string): Map<string, string> {
  const map = new Map<string, string>()
  const blockRe =
    /SHA-1 hash:\s*([0-9A-Fa-f]{40})[\s\S]*?(-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----)/g
  for (const match of stdout.matchAll(blockRe)) {
    map.set(match[1]!.toUpperCase(), match[2]!)
  }
  return map
}

/**
 * Extracts the `OU` field from `openssl x509 -noout -subject` output.
 * Supports both RFC2253 (`subject=UID=..., CN=..., OU=N2X78TUUFG, O=...`) and
 * legacy slash-separated (`subject= /UID=.../OU=N2X78TUUFG/...`) formats.
 *
 * Why OU instead of CN parentheses: `Apple Development: NAME (DF3BVL824L)`
 * places the *personal* ID in CN parentheses while the actual Team ID sits in
 * the X.509 `OU` attribute.
 */
export function extractOuFromSubject(subjectOutput: string): string | undefined {
  const match = subjectOutput.match(/(?:^|[,/\s])OU\s*=\s*"?([A-Za-z0-9]+)"?(?=$|[,/\r\n])/)
  return match?.[1]
}

export async function discoverSigningIdentities(platform: SafariPlatform, exec: Exec): Promise<SigningIdentity[]> {
  const idRes = await exec('security', ['find-identity', '-v', '-p', 'codesigning'])
  if (idRes.status !== 0) return []

  const candidates = parseFindIdentityOutput(idRes.stdout).filter((id) => isIdentityUsableForPlatform(id, platform))
  if (candidates.length === 0) return []

  const pemRes = await exec('security', ['find-certificate', '-a', '-Z', '-p'])
  const pems = pemRes.status === 0 ? parseCertPemBlocks(pemRes.stdout) : new Map<string, string>()

  for (const identity of candidates) {
    const pem = pems.get(identity.sha1)
    if (!pem) continue
    const subjRes = await exec('openssl', ['x509', '-noout', '-subject'], { input: pem })
    if (subjRes.status === 0) {
      identity.teamId = extractOuFromSubject(subjRes.stdout)
    }
  }

  return candidates
}

export interface SelectSigningOptions {
  platform: SafariPlatform
  identities: SigningIdentity[]
  signQuery?: string
  noSign?: boolean
  teamIdOverride?: string
  hasOutput: boolean
  isTTY: boolean
  promptSelect?: (identities: SigningIdentity[], platform: SafariPlatform) => Promise<SigningIdentity | 'none'>
}

export async function selectSigningIdentity(opts: SelectSigningOptions): Promise<SigningSelection> {
  if (opts.noSign) {
    if (opts.platform === 'ios' && !opts.hasOutput) {
      throw new Error(
        '--no-sign on iOS requires --output <path> (unsigned .ipa cannot be installed directly via devicectl)',
      )
    }
    return opts.platform === 'macos' ? { mode: 'adhoc', reason: 'explicit' } : { mode: 'unsigned', reason: 'explicit' }
  }

  const finalize = (identity: SigningIdentity): SigningSelection => {
    const teamId = opts.teamIdOverride ?? identity.teamId
    if (!teamId) {
      throw new Error(`could not determine Apple Developer Team ID for "${identity.name}" — pass --team-id <TEAM_ID>`)
    }
    return { mode: 'identity', identity, teamId }
  }

  if (opts.signQuery) {
    const query = opts.signQuery.trim()
    const queryUpper = query.toUpperCase()
    const queryLower = query.toLowerCase()
    const exact = opts.identities.find((id) => id.sha1 === queryUpper || id.name.toLowerCase() === queryLower)
    if (exact) return finalize(exact)

    const partial = opts.identities.filter(
      (id) => id.sha1.startsWith(queryUpper) || id.name.toLowerCase().includes(queryLower),
    )
    if (partial.length === 1) return finalize(partial[0]!)
    if (partial.length > 1) {
      throw new Error(
        `--sign "${query}" matched multiple identities:\n${partial.map((id) => `  - ${id.name} (${id.sha1})`).join('\n')}\nPass a more specific name or full SHA-1.`,
      )
    }
    const available = opts.identities.length
      ? opts.identities.map((id) => `  - ${id.name} (${id.sha1})`).join('\n')
      : '  (none found in Keychain)'
    throw new Error(`--sign "${query}" did not match any ${opts.platform} signing identity in Keychain:\n${available}`)
  }

  if (opts.identities.length === 0) {
    if (opts.platform === 'macos') {
      return { mode: 'adhoc', reason: 'fallback' }
    }
    if (opts.hasOutput) {
      return { mode: 'unsigned', reason: 'fallback' }
    }
    throw new Error(
      'no Apple Development certificate found in Keychain for iOS device install — sign in to Xcode (Settings → Accounts) with an Apple ID, or pass --no-sign --output <path> to export an unsigned .ipa',
    )
  }

  if (opts.identities.length === 1) {
    return finalize(opts.identities[0]!)
  }

  if (!opts.isTTY || !opts.promptSelect) {
    throw new Error(
      `multiple ${opts.platform} signing identities found in Keychain — pass --sign <name|sha1> or --no-sign:\n${opts.identities.map((id) => `  - ${id.name} (Team: ${id.teamId ?? '?'})`).join('\n')}`,
    )
  }

  const chosen = await opts.promptSelect(opts.identities, opts.platform)
  if (chosen === 'none') {
    if (opts.platform === 'ios' && !opts.hasOutput) {
      throw new Error(
        'unsigned iOS builds cannot be installed directly to a device — re-run with --output <path> to export an .ipa',
      )
    }
    return opts.platform === 'macos' ? { mode: 'adhoc', reason: 'explicit' } : { mode: 'unsigned', reason: 'explicit' }
  }
  return finalize(chosen)
}
