import { unzipSync } from 'fflate'
import { compareVersions, isValidExtensionVersion } from './version'
import type { Store } from './types'

/** The manifest.json fields push-time validation cares about — nothing more. */
export interface ExtensionManifest {
  manifest_version?: number
  version?: string
  background?: { service_worker?: string; scripts?: string[]; page?: string }
  browser_specific_settings?: { gecko?: { id?: string } }
  /** Legacy alias for browser_specific_settings, still honored by Firefox. */
  applications?: { gecko?: { id?: string } }
}

/** Extracts and parses manifest.json from a zip's root. Null on any failure — a zip without a readable manifest isn't an extension build. */
export function parseZipManifest(bytes: Uint8Array): ExtensionManifest | null {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, { filter: (file) => file.name === 'manifest.json' })
  } catch {
    return null
  }
  const manifestBytes = entries['manifest.json']
  if (!manifestBytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(manifestBytes)) as ExtensionManifest
  } catch {
    return null
  }
}

function geckoId(manifest: ExtensionManifest): string | undefined {
  return manifest.browser_specific_settings?.gecko?.id ?? manifest.applications?.gecko?.id
}

function versionMatches(manifestVersion: string | undefined, pushedVersion: string): boolean {
  if (manifestVersion === undefined) return false
  if (manifestVersion === pushedVersion) return true
  // "1.0" and "1.0.0" are the same version to every store.
  return isValidExtensionVersion(manifestVersion) && compareVersions(manifestVersion, pushedVersion) === 0
}

/**
 * The basic sanity checks each store's own review pipeline would otherwise
 * fail hours or days later: a zip that isn't an extension build, a version
 * that doesn't match what's being pushed, a Chrome-only build headed for
 * Firefox. `stores` is where this artifact will queue — pass [] for a
 * universal push with no targets yet (baseline checks still apply). Safari
 * never carries a zip through extport, so it contributes no checks.
 */
export function validateArtifactManifest(manifest: ExtensionManifest | null, version: string, stores: Store[]): string[] {
  if (manifest === null) {
    return ['zip has no parseable manifest.json at its root — this does not look like a browser-extension build']
  }

  const errors: string[] = []
  if (!versionMatches(manifest.version, version)) {
    errors.push(
      `zip's manifest.json declares version ${manifest.version ?? '(none)'} but this push is for ${version} — pushing the wrong file?`,
    )
  }

  if (stores.includes('firefox')) {
    if (!geckoId(manifest)) {
      errors.push(
        'firefox: manifest.json is missing browser_specific_settings.gecko.id — AMO requires it to match the upload to your add-on listing; build a Firefox-specific zip and push it with --store firefox',
      )
    }
    const bg = manifest.background
    if (bg?.service_worker && !bg.scripts && !bg.page) {
      errors.push(
        'firefox: background declares only a service_worker, which Firefox never runs — a Firefox build needs background.scripts',
      )
    }
  }

  if (stores.includes('chrome') && manifest.manifest_version !== 3) {
    errors.push(
      `chrome: manifest_version is ${manifest.manifest_version ?? '(none)'} — the Chrome Web Store only accepts Manifest V3`,
    )
  }

  return errors
}
