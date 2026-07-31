import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from './exec'

/**
 * Project scaffolding for `extport init` — download the template, wire the
 * extension identity in. The pieces are pure/injectable so they test
 * without a network or a terminal.
 */

/**
 * The same transform the fleet's wxt configs use to derive gecko ids from
 * manifest names — one convention, three artifacts (directory name,
 * package.json name, gecko id all agree).
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface ExtensionRecord {
  id: string
  name: string
}

export async function fetchExtensions(apiUrl: string, apiKey: string): Promise<ExtensionRecord[]> {
  try {
    const res = await fetch(new URL('/api/v1/extensions', apiUrl), { headers: { authorization: `Bearer ${apiKey}` } })
    if (!res.ok) return []
    const body = (await res.json()) as { extensions?: ExtensionRecord[] }
    return body.extensions ?? []
  } catch {
    return []
  }
}

export async function createExtension(apiUrl: string, apiKey: string, name: string): Promise<ExtensionRecord> {
  const res = await fetch(new URL('/api/v1/extensions', apiUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const body = (await res.json().catch(() => ({}))) as { extension?: ExtensionRecord; error?: string }
  if (!res.ok || !body.extension) {
    throw new Error(body.error ?? `could not create the extension (${res.status})`)
  }
  return body.extension
}

const TEMPLATE_TARBALL = 'https://codeload.github.com/rxliuli/browser-extension-template/tar.gz/refs/heads/main'

/**
 * Tarball + system tar (present on macOS, Linux, and Windows 10+) — the CLI
 * keeps its zero-runtime-dependency property.
 */
export async function downloadTemplate(targetDir: string, exec: Exec, tarballUrl = TEMPLATE_TARBALL): Promise<void> {
  const res = await fetch(tarballUrl)
  if (!res.ok) throw new Error(`could not download the template (${res.status}) — check your network and try again`)
  const tarball = join(tmpdir(), `extport-template-${Date.now()}.tar.gz`)
  await writeFile(tarball, new Uint8Array(await res.arrayBuffer()))
  try {
    await mkdir(targetDir, { recursive: true })
    const result = await exec('tar', ['xzf', tarball, '-C', targetDir, '--strip-components=1'])
    if (result.status !== 0) {
      throw new Error(`could not extract the template: ${result.stderr.trim() || `tar exited ${result.status}`}`)
    }
  } finally {
    await rm(tarball, { force: true })
  }
}

/**
 * Wire the identity into the fresh scaffold. Replacements target the
 * template's known literals; everything else (description, permissions,
 * homepage) stays template content for the author to edit.
 */
export async function patchScaffold(
  dir: string,
  identity: { extensionId: string; name: string; slug: string },
): Promise<void> {
  const packageJsonPath = join(dir, 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>
  packageJson.name = identity.slug
  await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n')

  const wxtConfigPath = join(dir, 'wxt.config.ts')
  const wxtConfig = await readFile(wxtConfigPath, 'utf8')
  await writeFile(
    wxtConfigPath,
    wxtConfig
      .replaceAll('ext_YOUR_EXTENSION_ID', identity.extensionId)
      .replaceAll('Browser Extension Template', identity.name)
      .replaceAll('browser-extension-template', identity.slug),
  )

  // Best-effort: the README is placeholder prose either way.
  const readmePath = join(dir, 'README.md')
  try {
    const readme = await readFile(readmePath, 'utf8')
    await writeFile(
      readmePath,
      readme.replaceAll('Browser Extension Template', identity.name).replaceAll('browser-extension-template', identity.slug),
    )
  } catch {
    // No README in the template — nothing to patch.
  }
}
