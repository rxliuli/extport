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

/**
 * Merges the Xcode project's known location (and team id, if configured) into
 * the existing extport.config.json without touching unrelated fields
 * (extension, apiUrl, safari.issuerId/keyId) — those stay whatever the tenant
 * already set via `extport init` / `extport safari-build`'s own prompts.
 */
export function syncSafariConfig(existing: ProjectConfig, update: { projectPath: string; teamId?: string }): { config: ProjectConfig; changed: boolean } {
  const safari = {
    ...existing.safari,
    projectPath: update.projectPath,
    ...(update.teamId ? { teamId: update.teamId } : {}),
  }
  const changed = existing.safari?.projectPath !== safari.projectPath || (update.teamId !== undefined && existing.safari?.teamId !== safari.teamId)
  return { config: { ...existing, safari }, changed }
}
