import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'

export interface LocalPackageJson {
  name?: string
  version?: string
}

export async function readPackageJson(cwd: string): Promise<LocalPackageJson | undefined> {
  try {
    return JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as LocalPackageJson
  } catch {
    return undefined
  }
}

/** WXT's default zip.artifactTemplate: "{{name}}-{{version}}-{{browser}}.zip", written to .output/. */
export function wxtZipPath(name: string, version: string, store: string): string {
  return join('.output', `${name}-${version}-${store}.zip`)
}

/** Reads manifest.json's "version" straight out of a built extension zip — the ground truth for what's actually in that artifact. */
export async function readZipManifestVersion(zipPath: string): Promise<string | undefined> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(zipPath))
  } catch {
    return undefined
  }
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, { filter: (file) => file.name === 'manifest.json' })
  } catch {
    return undefined
  }
  const manifestBytes = entries['manifest.json']
  if (!manifestBytes) return undefined
  try {
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { version?: string }
    return manifest.version
  } catch {
    return undefined
  }
}

/**
 * Fills in what a WXT project already declares, so a plain `extport push
 * --store chrome` needs no --file/--version: the zip's own manifest.json is
 * the ground truth when one exists (it's what's actually being uploaded);
 * package.json is the only signal left for --store safari, which has no zip.
 */
export async function inferPushDefaults(raw: { file?: string; version?: string }, store: string | undefined, cwd: string): Promise<{ file?: string; version?: string }> {
  const result: { file?: string; version?: string } = {}
  const pkg = await readPackageJson(cwd)

  if (!raw.file && store && store !== 'safari' && pkg?.name && pkg?.version) {
    const candidate = wxtZipPath(pkg.name, pkg.version, store)
    if (existsSync(resolve(cwd, candidate))) {
      result.file = candidate
    } else if (store === 'edge') {
      // Edge Add-ons accepts the same Chromium manifest v3 zip as Chrome —
      // WXT projects rarely build a distinct "edge" target for this reason.
      const chromeCandidate = wxtZipPath(pkg.name, pkg.version, 'chrome')
      if (existsSync(resolve(cwd, chromeCandidate))) result.file = chromeCandidate
    }
  }

  if (!raw.version) {
    const file = raw.file ?? result.file
    if (file) {
      result.version = await readZipManifestVersion(resolve(cwd, file))
    } else if (store === 'safari') {
      result.version = pkg?.version
    }
  }

  return result
}
