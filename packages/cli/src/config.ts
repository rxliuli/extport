import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_API_URL = 'https://dash.extport.dev'

/** Written by `extport login`, read as a fallback wherever --api-key/EXTPORT_API_KEY would go. */
export interface GlobalConfig {
  apiKey?: string
  apiUrl?: string
}

/**
 * `extport.config.json` in the current directory — checked in, no secrets.
 *
 * Intentionally does NOT include `apiUrl`: a checked-in repo config is
 * untrusted input and must never redirect credentials (stored global keys or
 * CI's EXTPORT_API_KEY) to another host. Use `--api-url` or `EXTPORT_API_URL`.
 */
export interface ProjectConfig {
  extension?: string
  safari?: {
    projectPath?: string
    teamId?: string
    issuerId?: string
    keyId?: string
  }
}

export function parseApiUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`invalid API URL "${rawUrl}" — expected an http:// or https:// URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`invalid API URL "${rawUrl}" — expected an http:// or https:// URL`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`invalid API URL "${rawUrl}" — credentials in URL are not allowed`)
  }
  return parsed
}

export function normalizeApiUrl(rawUrl: string): string {
  parseApiUrl(rawUrl)
  return rawUrl.replace(/\/+$/, '')
}

export function sameApiOrigin(a: string, b: string): boolean {
  try {
    return parseApiUrl(a).origin === parseApiUrl(b).origin
  } catch {
    return false
  }
}

export function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined
}

/**
 * Resolves the target API URL from trusted sources only: explicit flag,
 * environment variable, global login config, or the hosted default.
 * Project-level `extport.config.json` is deliberately excluded.
 */
export function resolveApiUrl(opts: {
  flagApiUrl?: string
  env?: Record<string, string | undefined>
  globalConfig?: GlobalConfig
}): string {
  const raw = opts.flagApiUrl ?? nonEmpty(opts.env?.EXTPORT_API_URL) ?? nonEmpty(opts.globalConfig?.apiUrl) ?? DEFAULT_API_URL
  return normalizeApiUrl(raw)
}

/**
 * Returns the globally stored API key only when the target API URL has the
 * same origin it was issued for — preventing a stored credential from being
 * sent to a different host (e.g. via `--api-url` or `EXTPORT_API_URL`).
 */
export function resolveStoredApiKey(globalConfig: GlobalConfig, targetApiUrl: string): string | undefined {
  const apiKey = nonEmpty(globalConfig.apiKey)
  if (!apiKey) return undefined
  const storedApiUrl = nonEmpty(globalConfig.apiUrl) ?? DEFAULT_API_URL
  return sameApiOrigin(targetApiUrl, storedApiUrl) ? apiKey : undefined
}

export function resolveCredentials(opts: {
  flagApiUrl?: string
  flagApiKey?: string
  env?: Record<string, string | undefined>
  globalConfig?: GlobalConfig
}): { apiUrl: string; apiKey: string } {
  const globalConfig = opts.globalConfig ?? {}
  const apiUrl = resolveApiUrl({ flagApiUrl: opts.flagApiUrl, env: opts.env, globalConfig })
  const explicitKey = opts.flagApiKey ?? nonEmpty(opts.env?.EXTPORT_API_KEY)
  if (explicitKey) return { apiUrl, apiKey: explicitKey }

  const storedKey = resolveStoredApiKey(globalConfig, apiUrl)
  if (storedKey) return { apiUrl, apiKey: storedKey }

  if (nonEmpty(globalConfig.apiKey)) {
    const storedApiUrl = nonEmpty(globalConfig.apiUrl) ?? DEFAULT_API_URL
    throw new Error(
      `not logged in for ${apiUrl} (stored credentials belong to ${storedApiUrl}) — run 'extport login --api-url ${apiUrl}' or pass --api-key / EXTPORT_API_KEY`,
    )
  }
  throw new Error("not logged in — run 'extport login'")
}

export function warnIfProjectApiUrl(projectConfig: unknown, warn: (msg: string) => void = console.warn): boolean {
  if (
    projectConfig !== null &&
    typeof projectConfig === 'object' &&
    'apiUrl' in projectConfig &&
    typeof (projectConfig as { apiUrl?: unknown }).apiUrl === 'string' &&
    (projectConfig as { apiUrl: string }).apiUrl.trim().length > 0
  ) {
    warn('warning: ignoring "apiUrl" in extport.config.json — pass --api-url or set EXTPORT_API_URL instead')
    return true
  }
  return false
}

function globalConfigPath(home: string): string {
  return join(home, '.config', 'extport', 'config.json')
}

export async function loadGlobalConfig(home: string = homedir()): Promise<GlobalConfig> {
  try {
    return JSON.parse(await readFile(globalConfigPath(home), 'utf8')) as GlobalConfig
  } catch {
    return {}
  }
}

// 0o600 — this is the only thing on disk holding the API key in plaintext,
// same posture as ~/.npmrc's auth tokens.
export async function saveGlobalConfig(config: GlobalConfig, home: string = homedir()): Promise<void> {
  await mkdir(join(home, '.config', 'extport'), { recursive: true })
  await writeFile(globalConfigPath(home), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

export async function clearGlobalConfig(home: string = homedir()): Promise<void> {
  await rm(globalConfigPath(home), { force: true })
}

const PROJECT_CONFIG_FILE = 'extport.config.json'

export async function loadProjectConfig(cwd: string = process.cwd()): Promise<ProjectConfig> {
  try {
    return JSON.parse(await readFile(join(cwd, PROJECT_CONFIG_FILE), 'utf8')) as ProjectConfig
  } catch {
    return {}
  }
}

export async function saveProjectConfig(config: ProjectConfig, cwd: string = process.cwd()): Promise<void> {
  await writeFile(join(cwd, PROJECT_CONFIG_FILE), JSON.stringify(config, null, 2) + '\n')
}
