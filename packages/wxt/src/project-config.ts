import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Mirrors @extport/cli's extport.config.json shape (packages/cli/src/config.ts) —
 * duplicated rather than imported so this package stays independent of the CLI's
 * own dependency footprint (citty, @clack/prompts) for WXT projects that pull it in.
 */
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

const PROJECT_CONFIG_FILE = 'extport.config.json'

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  try {
    return JSON.parse(await readFile(join(cwd, PROJECT_CONFIG_FILE), 'utf8')) as ProjectConfig
  } catch {
    return {}
  }
}

export async function saveProjectConfig(config: ProjectConfig, cwd: string): Promise<void> {
  await writeFile(join(cwd, PROJECT_CONFIG_FILE), JSON.stringify(config, null, 2) + '\n')
}

/** Drop undefined values so an unauthored field can never clobber an existing one. */
function definedEntries<T extends Record<string, unknown>>(obj: T | undefined): Partial<T> {
  if (!obj) return {}
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

/**
 * Regenerates extport.config.json from the wxt.config.ts-authored values —
 * in full, at setup time, so the file reaches its final state on
 * `pnpm install` instead of accreting fields across lifecycle stages.
 * Authored values win; fields the module doesn't own (apiUrl, anything the
 * CLI wrote that isn't re-authored) pass through untouched — non-WXT
 * projects that hand-write this file are unaffected by definition.
 */
export function generateProjectConfig(
  existing: ProjectConfig,
  authored: { extension?: string; safari?: { projectPath?: string; teamId?: string; issuerId?: string; keyId?: string } },
): { config: ProjectConfig; changed: boolean } {
  const safari = { ...existing.safari, ...definedEntries(authored.safari) }
  const config: ProjectConfig = {
    ...existing,
    ...(authored.extension !== undefined ? { extension: authored.extension } : {}),
    ...(Object.keys(safari).length > 0 ? { safari } : {}),
  }
  const changed = JSON.stringify(config) !== JSON.stringify(existing)
  return { config, changed }
}
