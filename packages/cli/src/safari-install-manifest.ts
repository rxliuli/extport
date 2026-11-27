import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface UnsupportedApiWarning {
  api: string
  reason: string
}

export interface InspectedExtension {
  appName: string
  rawName: string
  version: string
  warnings: UnsupportedApiWarning[]
}

interface RawManifest {
  manifest_version?: unknown
  name?: unknown
  short_name?: unknown
  version?: unknown
  default_locale?: unknown
  permissions?: unknown
  optional_permissions?: unknown
  side_panel?: unknown
}

const MSG_RE = /^__MSG_([^_].*?)__$/

const UNSUPPORTED_PERMISSIONS: ReadonlyArray<{ key: string; api: string; reason: string }> = [
  { key: 'identity', api: 'chrome.identity', reason: 'OAuth / Google identity APIs are not supported in Safari' },
  { key: 'offscreen', api: 'chrome.offscreen', reason: 'Offscreen documents are not supported in Safari' },
  { key: 'sidePanel', api: 'chrome.sidePanel', reason: 'Side panel UI is not supported in Safari' },
  { key: 'debugger', api: 'chrome.debugger', reason: 'Chrome DevTools debugger protocol is not supported in Safari' },
  { key: 'tabGroups', api: 'chrome.tabGroups', reason: 'Chrome tab groups API is not supported in Safari' },
  { key: 'gcm', api: 'chrome.gcm', reason: 'Google Cloud Messaging is not supported in Safari' },
  {
    key: 'enterprise.deviceAttributes',
    api: 'chrome.enterprise.*',
    reason: 'Chrome Enterprise APIs are not supported in Safari',
  },
  {
    key: 'enterprise.hardwarePlatform',
    api: 'chrome.enterprise.*',
    reason: 'Chrome Enterprise APIs are not supported in Safari',
  },
  {
    key: 'enterprise.networkingAttributes',
    api: 'chrome.enterprise.*',
    reason: 'Chrome Enterprise APIs are not supported in Safari',
  },
  {
    key: 'enterprise.platformKeys',
    api: 'chrome.enterprise.*',
    reason: 'Chrome Enterprise APIs are not supported in Safari',
  },
]

/**
 * Checks a manifest for Chrome-only APIs known to be unsupported in Safari.
 * Warnings are advisory only — conversion still proceeds.
 */
export function detectUnsupportedSafariApis(manifest: Record<string, unknown>): UnsupportedApiWarning[] {
  const declared = new Set<string>()
  for (const field of ['permissions', 'optional_permissions'] as const) {
    const list = manifest[field]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (typeof item === 'string') declared.add(item)
    }
  }

  const warnings: UnsupportedApiWarning[] = []
  const seenApis = new Set<string>()
  const add = (api: string, reason: string) => {
    if (seenApis.has(api)) return
    seenApis.add(api)
    warnings.push({ api, reason })
  }

  for (const check of UNSUPPORTED_PERMISSIONS) {
    if (declared.has(check.key)) add(check.api, check.reason)
  }
  if (manifest.side_panel && typeof manifest.side_panel === 'object') {
    add('chrome.sidePanel', 'Side panel UI is not supported in Safari')
  }

  return warnings
}

async function readLocaleMessage(
  unpackedDir: string,
  defaultLocale: string | undefined,
  key: string,
): Promise<string | undefined> {
  const localesDir = path.join(unpackedDir, '_locales')
  if (!existsSync(localesDir)) return undefined

  const candidates: string[] = []
  if (defaultLocale) candidates.push(defaultLocale)
  candidates.push('en', 'en_US', 'en-US')

  const available = await readdir(localesDir, { withFileTypes: true }).catch(() => [])
  for (const entry of available) {
    if (entry.isDirectory() && !candidates.includes(entry.name)) candidates.push(entry.name)
  }

  const targetLower = key.toLowerCase()
  for (const locale of candidates) {
    const file = path.join(localesDir, locale, 'messages.json')
    if (!existsSync(file)) continue
    try {
      const raw = (await readFile(file, 'utf-8')).replace(/^\uFEFF/, '')
      const messages = JSON.parse(raw) as Record<string, { message?: unknown }>
      for (const [entryKey, entryVal] of Object.entries(messages)) {
        if (
          entryKey.toLowerCase() === targetLower &&
          typeof entryVal?.message === 'string' &&
          entryVal.message.trim()
        ) {
          return entryVal.message.trim()
        }
      }
    } catch {
      // Malformed locale file — fall through to the next candidate.
    }
  }
  return undefined
}

/**
 * Strips characters that break macOS filenames or Xcode scheme/project names.
 */
export function sanitizeAppName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[/:\\?*|"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim()
  return cleaned || fallback
}

/**
 * Normalizes a Chrome manifest version (1–4 dot-separated integers, sometimes
 * with leading zeros) into a valid Apple `CFBundleShortVersionString` (1–3
 * dot-separated non-negative integers).
 */
export function normalizeExtensionVersion(raw: string | undefined): string {
  if (!raw) return '1.0.0'
  const parts = raw
    .trim()
    .split('.')
    .slice(0, 3)
    .map((segment) => {
      const match = segment.match(/^\d+/)
      return match ? String(Number.parseInt(match[0], 10)) : undefined
    })
    .filter((segment): segment is string => segment !== undefined)
  return parts.length > 0 ? parts.join('.') : '1.0.0'
}

/**
 * Deterministic bundle identifier so repeat installs of the same extension
 * overwrite in place (preserving Safari settings & storage) while scoping by
 * Team ID to avoid collisions on Apple's global App ID registry.
 */
export function buildDeterministicBundleId(opts: { cwsId?: string; appName: string; teamId?: string }): string {
  const scope = opts.teamId ? opts.teamId.toLowerCase().replace(/[^a-z0-9]/g, '') || 'local' : 'local'
  let slug: string
  if (opts.cwsId) {
    slug = opts.cwsId.toLowerCase()
  } else {
    const ascii = opts.appName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '')
    if (ascii.length >= 2) {
      slug = ascii
    } else {
      const hash = createHash('sha256').update(opts.appName).digest('hex').slice(0, 8)
      slug = `ext-${hash}`
    }
  }
  return `dev.extport.${scope}.${slug}`
}

export async function inspectExtensionManifest(unpackedDir: string, fallbackName: string): Promise<InspectedExtension> {
  const manifestPath = path.join(unpackedDir, 'manifest.json')
  let manifest: RawManifest
  try {
    const raw = (await readFile(manifestPath, 'utf-8')).replace(/^\uFEFF/, '')
    manifest = JSON.parse(raw) as RawManifest
  } catch (err) {
    throw new Error(`failed to read manifest.json: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (manifest.manifest_version !== 3) {
    throw new Error(
      `only Manifest V3 extensions are supported (got manifest_version: ${String(manifest.manifest_version ?? 'missing')})`,
    )
  }

  const rawName = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : fallbackName
  let resolvedName = rawName
  const msgMatch = rawName.match(MSG_RE)
  if (msgMatch) {
    const defaultLocale = typeof manifest.default_locale === 'string' ? manifest.default_locale : undefined
    const localized = await readLocaleMessage(unpackedDir, defaultLocale, msgMatch[1]!)
    resolvedName =
      localized ??
      (typeof manifest.short_name === 'string' && !MSG_RE.test(manifest.short_name)
        ? manifest.short_name
        : fallbackName)
  }

  const appName = sanitizeAppName(resolvedName, sanitizeAppName(fallbackName, 'Safari Extension'))
  const version = normalizeExtensionVersion(typeof manifest.version === 'string' ? manifest.version : undefined)
  const warnings = detectUnsupportedSafariApis(manifest as Record<string, unknown>)

  return { appName, rawName: resolvedName, version, warnings }
}
