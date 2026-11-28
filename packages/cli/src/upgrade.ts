import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec } from './exec'

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'
export const DEFAULT_INSTALL_SCRIPT_URL = 'https://extport.dev/install.sh'

export type InstallSourceKind = 'installer' | 'npx' | 'pnpx' | 'bunx' | 'pnpm' | 'bun' | 'yarn' | 'npm' | 'unknown'

export interface InstallSource {
  kind: InstallSourceKind
  upgradeCommand?: string
}

export function detectInstallSource(opts: {
  env?: Record<string, string | undefined>
  scriptPath?: string
}): InstallSource {
  const env = opts.env ?? {}
  if (env.EXTPORT_INSTALL_METHOD === 'installer') {
    return { kind: 'installer' }
  }

  const normalized = (opts.scriptPath ?? '').replaceAll('\\', '/').toLowerCase()

  if (normalized.includes('/_npx/')) {
    return { kind: 'npx', upgradeCommand: 'npx @extport/cli@latest' }
  }
  if (normalized.includes('/pnpm/dlx/') || normalized.includes('/dlx-')) {
    return { kind: 'pnpx', upgradeCommand: 'pnpm dlx @extport/cli@latest' }
  }
  if (normalized.includes('/.bun/install/cache/') || normalized.includes('/bunx-')) {
    return { kind: 'bunx', upgradeCommand: 'bunx @extport/cli@latest' }
  }
  if (
    normalized.includes('/pnpm/global/') ||
    normalized.includes('/.local/share/pnpm/') ||
    normalized.includes('/library/pnpm/')
  ) {
    return { kind: 'pnpm', upgradeCommand: 'pnpm add -g @extport/cli@latest' }
  }
  if (normalized.includes('/.bun/install/global/')) {
    return { kind: 'bun', upgradeCommand: 'bun add -g @extport/cli@latest' }
  }
  if (normalized.includes('/yarn/global/') || normalized.includes('/.config/yarn/global/')) {
    return { kind: 'yarn', upgradeCommand: 'yarn global add @extport/cli@latest' }
  }
  if (normalized.includes('/node_modules/@extport/cli/')) {
    return { kind: 'npm', upgradeCommand: 'npm install -g @extport/cli@latest' }
  }

  return { kind: 'unknown' }
}

interface ParsedSemver {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parseSemver(raw: string): ParsedSemver | undefined {
  const cleaned = raw.trim().replace(/^v/i, '').split('+', 1)[0]!
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(cleaned)
  if (!match) return undefined
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/**
 * Compares two SemVer strings. Returns >0 if `a > b`, <0 if `a < b`, 0 if equal.
 * Falls back to lexicographic inequality when either string is not valid SemVer.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) {
    if (a === b) return 0
    return a > b ? 1 : -1
  }

  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch

  const aPre = pa.prerelease
  const bPre = pb.prerelease
  if (aPre.length === 0 && bPre.length === 0) return 0
  if (aPre.length === 0) return 1
  if (bPre.length === 0) return -1

  const len = Math.max(aPre.length, bPre.length)
  for (let i = 0; i < len; i++) {
    const ai = aPre[i]
    const bi = bPre[i]
    if (ai === undefined) return -1
    if (bi === undefined) return 1
    if (ai === bi) continue
    const aNum = /^\d+$/.test(ai)
    const bNum = /^\d+$/.test(bi)
    if (aNum && bNum) return Number.parseInt(ai, 10) - Number.parseInt(bi, 10)
    if (aNum) return -1
    if (bNum) return 1
    return ai < bi ? -1 : 1
  }

  return 0
}

export async function fetchLatestCliVersion(
  registryUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const url = `${registryUrl.replace(/\/+$/, '')}/@extport/cli/latest`
  let res: Response
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  } catch (err) {
    throw new Error(`could not reach npm registry (${url}): ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    throw new Error(`npm registry returned HTTP ${res.status} for ${url}`)
  }
  const data = (await res.json()) as { version?: unknown }
  if (typeof data.version !== 'string' || !data.version.trim()) {
    throw new Error('npm registry response did not include a valid version')
  }
  return data.version.trim()
}

export function formatExternalUpgradeMessage(source: InstallSource): string {
  switch (source.kind) {
    case 'npx':
    case 'pnpx':
    case 'bunx':
      return `You are running extport via a temporary package runner. Pass @latest to always use the newest release:\n  ${source.upgradeCommand} ...`
    case 'npm':
    case 'pnpm':
    case 'bun':
    case 'yarn':
      return `extport was installed via ${source.kind}. To upgrade, run:\n  ${source.upgradeCommand}`
    default:
      return (
        'Self-upgrade is only supported for standalone macOS installs (https://extport.dev/install.sh).\n' +
        'Upgrade using the package manager you installed @extport/cli with, or run:\n' +
        '  npx @extport/cli@latest'
      )
  }
}

export interface UpgradeOptions {
  currentVersion: string
  force?: boolean
}

export interface RunUpgradeDeps {
  exec: Exec
  fetch?: typeof globalThis.fetch
  env?: Record<string, string | undefined>
  scriptPath?: string
  registryUrl?: string
  installScriptUrl?: string
  log?: (msg: string) => void
}

export interface UpgradeResult {
  status: 'up-to-date' | 'upgraded' | 'managed-externally'
  currentVersion: string
  latestVersion: string
  source: InstallSource
}

export async function runUpgrade(options: UpgradeOptions, deps: RunUpgradeDeps): Promise<UpgradeResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const env = deps.env ?? process.env
  const log = deps.log ?? console.log
  const registryUrl = deps.registryUrl ?? env.EXTPORT_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY
  const installScriptUrl = deps.installScriptUrl ?? env.EXTPORT_INSTALL_SCRIPT_URL ?? DEFAULT_INSTALL_SCRIPT_URL

  const source = detectInstallSource({ env, scriptPath: deps.scriptPath ?? process.argv[1] })
  const latestVersion = await fetchLatestCliVersion(registryUrl, fetchImpl)
  const hasUpdate = compareSemver(latestVersion, options.currentVersion) > 0

  if (source.kind !== 'installer') {
    if (hasUpdate) {
      log(`extport v${options.currentVersion} → v${latestVersion} is available.`)
    } else {
      log(`extport v${options.currentVersion} is already up to date.`)
    }
    log(formatExternalUpgradeMessage(source))
    return {
      status: 'managed-externally',
      currentVersion: options.currentVersion,
      latestVersion,
      source,
    }
  }

  if (!options.force && !hasUpdate) {
    log(`extport v${options.currentVersion} is already up to date.`)
    return {
      status: 'up-to-date',
      currentVersion: options.currentVersion,
      latestVersion,
      source,
    }
  }

  if (hasUpdate) {
    log(`Upgrading extport v${options.currentVersion} → v${latestVersion}…`)
  } else {
    log(`Reinstalling extport v${latestVersion}…`)
  }

  let scriptRes: Response
  try {
    scriptRes = await fetchImpl(installScriptUrl)
  } catch (err) {
    throw new Error(
      `could not download installer (${installScriptUrl}): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!scriptRes.ok) {
    throw new Error(`installer download failed with HTTP ${scriptRes.status} (${installScriptUrl})`)
  }
  const scriptText = await scriptRes.text()
  if (!scriptText.startsWith('#!/bin/sh')) {
    throw new Error(`unexpected installer response from ${installScriptUrl} (expected a #!/bin/sh script)`)
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'extport-upgrade-'))
  try {
    const scriptFile = path.join(workDir, 'install.sh')
    await writeFile(scriptFile, scriptText, 'utf8')
    await chmod(scriptFile, 0o700)

    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      EXTPORT_UPGRADE: '1',
    }
    const res = await deps.exec('/bin/sh', [scriptFile], { stream: true, env: childEnv })
    if (res.status !== 0) {
      throw new Error(`installer exited with code ${res.status}`)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }

  return {
    status: 'upgraded',
    currentVersion: options.currentVersion,
    latestVersion,
    source,
  }
}
