import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { sanitizeAppName, type UnsupportedApiWarning } from './safari-install-manifest'

export const DEFAULT_FIREFOX_MIN_VERSION = '128.0'

/** Mozilla WebExtension add-on ID: email-like string OR braced UUID. */
const GECKO_EMAIL_ID_RE = /^[a-zA-Z0-9-._]+@[a-zA-Z0-9-._]+$/
const GECKO_UUID_ID_RE = /^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/
const MSG_RE = /^__MSG_([^_].*?)__$/

export function isValidGeckoId(id: string): boolean {
  return GECKO_EMAIL_ID_RE.test(id) || GECKO_UUID_ID_RE.test(id)
}

export interface InspectedFirefoxExtension {
  appName: string
  rawName: string
  version: string
  existingGeckoId?: string
  existingMinVersion?: string
  warnings: UnsupportedApiWarning[]
}

const UNSUPPORTED_FIREFOX_PERMISSIONS: ReadonlyArray<{ key: string; api: string; reason: string }> = [
  {
    key: 'offscreen',
    api: 'chrome.offscreen',
    reason: 'Offscreen documents are not supported in Firefox (Event Pages already have DOM access)',
  },
  { key: 'fontSettings', api: 'chrome.fontSettings', reason: 'Chrome font settings API is not supported in Firefox' },
  { key: 'readingList', api: 'chrome.readingList', reason: 'Chrome Reading List API is not supported in Firefox' },
  { key: 'debugger', api: 'chrome.debugger', reason: 'Chrome DevTools debugger protocol is not supported in Firefox' },
  { key: 'gcm', api: 'chrome.gcm', reason: 'Google Cloud Messaging is not supported in Firefox' },
  { key: 'favicon', api: 'chrome.favicon', reason: 'Chrome _favicon API is not supported in Firefox' },
  { key: 'tabCapture', api: 'chrome.tabCapture', reason: 'Chrome tabCapture API is not supported in Firefox' },
  {
    key: 'desktopCapture',
    api: 'chrome.desktopCapture',
    reason: 'Chrome desktopCapture API is not supported in Firefox',
  },
  {
    key: 'enterprise.deviceAttributes',
    api: 'chrome.enterprise.*',
    reason: 'Chrome Enterprise APIs are not supported in Firefox',
  },
  {
    key: 'enterprise.hardwarePlatform',
    api: 'chrome.enterprise.*',
    reason: 'Chrome Enterprise APIs are not supported in Firefox',
  },
  {
    key: 'enterprise.networkingAttributes',
    api: 'chrome.enterprise.*',
    reason: 'Chrome Enterprise APIs are not supported in Firefox',
  },
  {
    key: 'enterprise.platformKeys',
    api: 'chrome.enterprise.*',
    reason: 'Chrome Enterprise APIs are not supported in Firefox',
  },
]

/**
 * Checks a Chrome MV3 manifest for APIs known to be unsupported in Firefox.
 * Warnings are advisory only — conversion still proceeds.
 */
export function detectUnsupportedFirefoxApis(manifest: Record<string, unknown>): UnsupportedApiWarning[] {
  const declared = new Set<string>()
  for (const field of ['permissions', 'optional_permissions'] as const) {
    const list = manifest[field]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (typeof item === 'string') declared.add(item)
    }
  }

  const warnings: UnsupportedApiWarning[] = []
  const seen = new Set<string>()
  const add = (api: string, reason: string) => {
    if (seen.has(api)) return
    seen.add(api)
    warnings.push({ api, reason })
  }

  for (const check of UNSUPPORTED_FIREFOX_PERMISSIONS) {
    if (declared.has(check.key)) add(check.api, check.reason)
  }
  if (manifest.sandbox && typeof manifest.sandbox === 'object') {
    add('sandbox', 'Sandboxed manifest pages are not supported in Firefox')
  }
  if (manifest.oauth2 && typeof manifest.oauth2 === 'object') {
    add('oauth2', 'Manifest oauth2 / chrome.identity.getAuthToken is Chrome-only (use identity.launchWebAuthFlow)')
  }

  return warnings
}

export function buildDeterministicGeckoId(opts: { cwsId?: string; appName: string; existingGeckoId?: string }): string {
  if (opts.existingGeckoId && isValidGeckoId(opts.existingGeckoId)) {
    return opts.existingGeckoId
  }

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
  return `${slug}@port.extport.dev`
}

export function slugifyFilename(appName: string, fallback: string): string {
  const ascii = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  if (ascii.length >= 2) return ascii
  const fb = fallback
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  if (fb.length >= 2) return fb
  return `ext-${createHash('sha256').update(appName).digest('hex').slice(0, 8)}`
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

export async function inspectFirefoxManifest(
  unpackedDir: string,
  fallbackName: string,
): Promise<InspectedFirefoxExtension> {
  const manifestPath = path.join(unpackedDir, 'manifest.json')
  let manifest: Record<string, unknown>
  try {
    const raw = (await readFile(manifestPath, 'utf-8')).replace(/^\uFEFF/, '')
    manifest = JSON.parse(raw) as Record<string, unknown>
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

  const appName = sanitizeAppName(resolvedName, sanitizeAppName(fallbackName, 'Firefox Extension'))
  const version = typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : '1.0.0'

  const bss =
    manifest.browser_specific_settings && typeof manifest.browser_specific_settings === 'object'
      ? (manifest.browser_specific_settings as Record<string, unknown>)
      : undefined
  const gecko = bss?.gecko && typeof bss.gecko === 'object' ? (bss.gecko as Record<string, unknown>) : undefined
  const existingGeckoId = typeof gecko?.id === 'string' && gecko.id.trim() ? gecko.id.trim() : undefined
  const existingMinVersion =
    typeof gecko?.strict_min_version === 'string' && gecko.strict_min_version.trim()
      ? gecko.strict_min_version.trim()
      : undefined

  const warnings = detectUnsupportedFirefoxApis(manifest)

  return { appName, rawName: resolvedName, version, existingGeckoId, existingMinVersion, warnings }
}
