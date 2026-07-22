import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Written by `extport login`, read as a fallback wherever --api-key/EXTPORT_API_KEY would go. */
export interface GlobalConfig {
  apiKey?: string
  apiUrl?: string
}

/** `extport.config.json` in the current directory — checked in, no secrets. */
export interface ProjectConfig {
  extension?: string
  apiUrl?: string
  safari?: {
    projectPath?: string
    teamId?: string
    issuerId?: string
    keyId?: string
  }
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
