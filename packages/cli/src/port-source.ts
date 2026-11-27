import { unzipSync } from 'fflate'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const CWS_ID_RE = /^[a-p]{32}$/
const CRX_MAGIC = 0x34327243 // 'Cr24' little-endian
export const DEFAULT_CHROME_VERSION = '150.0.0.0'

/**
 * Accepts a Chrome Web Store URL (current `chromewebstore.google.com` or
 * legacy `chrome.google.com/webstore`) or a bare 32-character extension ID
 * (`[a-p]{32}`) and returns the extension ID.
 */
export function parseCwsExtensionId(input: string): string | undefined {
  const trimmed = input.trim()
  if (CWS_ID_RE.test(trimmed)) return trimmed

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }

  const isNewCws = url.hostname === 'chromewebstore.google.com'
  const isLegacyCws = url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore/')
  if (!isNewCws && !isLegacyCws) return undefined

  const segments = url.pathname.split('/').filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!
    if (CWS_ID_RE.test(segment)) return segment
  }
  return undefined
}

export function buildCwsCrxUrl(extensionId: string, chromeVersion = DEFAULT_CHROME_VERSION): string {
  const params = new URLSearchParams({
    response: 'redirect',
    prodversion: chromeVersion,
    acceptformat: 'crx2,crx3',
  })
  // `x` carries its own URL-encoded sub-params (`id=<id>&uc`), matching
  // Chrome's update protocol.
  return `https://clients2.google.com/service/update2/crx?${params.toString()}&x=id%3D${extensionId}%26uc`
}

/**
 * Strips a CRX2 or CRX3 header and returns the underlying ZIP archive slice.
 */
export function extractZipFromCrx(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 12) {
    throw new Error('invalid CRX archive: file is truncated')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== CRX_MAGIC) {
    throw new Error('invalid CRX archive: missing Cr24 header')
  }

  const version = view.getUint32(4, true)
  let zipOffset: number
  if (version === 3) {
    const headerSize = view.getUint32(8, true)
    zipOffset = 12 + headerSize
  } else if (version === 2) {
    if (bytes.byteLength < 16) throw new Error('invalid CRX2 archive: file is truncated')
    const publicKeyLength = view.getUint32(8, true)
    const signatureLength = view.getUint32(12, true)
    zipOffset = 16 + publicKeyLength + signatureLength
  } else {
    throw new Error(`unsupported CRX format version: ${version}`)
  }

  if (zipOffset >= bytes.byteLength) {
    throw new Error('invalid CRX archive: header length exceeds file size')
  }
  return bytes.subarray(zipOffset)
}

/**
 * Unzips a ZIP archive into `destDir` with Zip Slip protection, ignoring
 * macOS `__MACOSX/` metadata entries. If the archive wraps the extension in a
 * single top-level directory containing `manifest.json`, returns that
 * directory instead of `destDir`.
 */
export async function unzipExtensionSafely(zipBytes: Uint8Array, destDir: string): Promise<string> {
  const entries = unzipSync(zipBytes)
  const resolvedRoot = path.resolve(destDir)
  await mkdir(resolvedRoot, { recursive: true })

  for (const [rawName, data] of Object.entries(entries)) {
    const normalized = rawName.replaceAll('\\', '/')
    if (!normalized || normalized.endsWith('/')) continue
    if (normalized.startsWith('__MACOSX/') || normalized.includes('/__MACOSX/')) continue

    const targetPath = path.resolve(resolvedRoot, normalized)
    if (targetPath !== resolvedRoot && !targetPath.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`refusing to extract unsafe archive path: ${rawName}`)
    }

    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, data)
  }

  if (existsSync(path.join(resolvedRoot, 'manifest.json'))) {
    return resolvedRoot
  }

  const topEntries = (await readdir(resolvedRoot, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name !== '__MACOSX',
  )
  if (topEntries.length === 1) {
    const nested = path.join(resolvedRoot, topEntries[0]!.name)
    if (existsSync(path.join(nested, 'manifest.json'))) {
      return nested
    }
  }

  throw new Error('unpacked archive does not contain a manifest.json')
}

export interface ResolvedExtensionSource {
  unpackedDir: string
  cwsId?: string
  fallbackName: string
  label: string
}

export interface ResolveSourceDeps {
  fetch?: typeof globalThis.fetch
  env?: Record<string, string | undefined>
  log?: (msg: string) => void
}

export async function resolveExtensionSource(
  source: string,
  workDir: string,
  deps: ResolveSourceDeps = {},
): Promise<ResolvedExtensionSource> {
  const fetchFn = deps.fetch ?? globalThis.fetch
  const env = deps.env ?? process.env
  const log = deps.log ?? console.log

  if (existsSync(source)) {
    const resolved = path.resolve(source)
    const info = await stat(resolved)
    if (info.isDirectory()) {
      if (!existsSync(path.join(resolved, 'manifest.json'))) {
        throw new Error(`directory does not contain manifest.json: ${source}`)
      }
      return { unpackedDir: resolved, fallbackName: path.basename(resolved), label: resolved }
    }

    const lower = resolved.toLowerCase()
    const raw = await readFile(resolved)
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    const extractDir = path.join(workDir, 'unpacked')
    const baseName = path.basename(resolved, path.extname(resolved))

    if (lower.endsWith('.crx')) {
      log(`── unpacking CRX "${path.basename(resolved)}" ──`)
      const unpackedDir = await unzipExtensionSafely(extractZipFromCrx(bytes), extractDir)
      return { unpackedDir, fallbackName: baseName, label: resolved }
    }

    if (lower.endsWith('.zip') || lower.endsWith('.xpi')) {
      log(`── unpacking archive "${path.basename(resolved)}" ──`)
      const unpackedDir = await unzipExtensionSafely(bytes, extractDir)
      return { unpackedDir, fallbackName: baseName, label: resolved }
    }

    throw new Error(`unsupported local source "${source}" — expected a directory, .crx, .zip, or .xpi`)
  }

  const cwsId = parseCwsExtensionId(source)
  if (!cwsId) {
    throw new Error(
      `cannot resolve "${source}" — pass a Chrome Web Store URL, 32-char extension ID, or existing directory / .crx / .zip`,
    )
  }

  const chromeVersion = env.EXTPORT_CHROME_VERSION?.trim() || DEFAULT_CHROME_VERSION
  const downloadUrl = buildCwsCrxUrl(cwsId, chromeVersion)
  log(`── downloading ${cwsId} from Chrome Web Store ──`)

  const res = await fetchFn(downloadUrl, { redirect: 'follow' })
  if (res.status === 204) {
    throw new Error(
      `Chrome Web Store returned 204 No Content for "${cwsId}" — the extension may be removed, unlisted, region-restricted, or incompatible with Chrome ${chromeVersion} (override via EXTPORT_CHROME_VERSION)`,
    )
  }
  if (!res.ok) {
    throw new Error(`failed to download "${cwsId}" from Chrome Web Store (HTTP ${res.status})`)
  }

  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength === 0) {
    throw new Error(`Chrome Web Store returned an empty archive for "${cwsId}"`)
  }

  const unpackedDir = await unzipExtensionSafely(extractZipFromCrx(buf), path.join(workDir, 'unpacked'))
  return { unpackedDir, cwsId, fallbackName: cwsId, label: `cws:${cwsId}` }
}
