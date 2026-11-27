import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FirefoxPortOptions } from './firefox-port-args'
import { patchExtensionForFirefox } from './firefox-port-compat'
import {
  buildDeterministicGeckoId,
  DEFAULT_FIREFOX_MIN_VERSION,
  inspectFirefoxManifest,
  slugifyFilename,
} from './firefox-port-manifest'
import { copyDirectoryClean, packageXpi } from './firefox-port-package'
import {
  discoverFirefoxBinaries,
  launchFirefoxWithExtension,
  resolveFirefoxBinary,
  type FirefoxBinary,
  type RdpAddonInstallResult,
} from './firefox-port-runner'
import { resolveExtensionSource } from './port-source'

export function resolveFirefoxOutputPath(opts: {
  output?: string
  cwd: string
  slug: string
  unpacked: boolean
}): string {
  if (!opts.output) {
    return path.resolve(opts.cwd, opts.unpacked ? `${opts.slug}-firefox` : `${opts.slug}-firefox.xpi`)
  }
  const resolved = path.resolve(opts.cwd, opts.output)
  if (opts.unpacked) return resolved
  if (resolved.toLowerCase().endsWith('.xpi')) return resolved
  return path.join(resolved, `${opts.slug}-firefox.xpi`)
}

export interface FirefoxPortResult {
  appName: string
  version: string
  geckoId: string
  minVersion: string
  changes: string[]
  patchedPages: string[]
  outputPath?: string
  keptUnpackedPath?: string
  runResult?: RdpAddonInstallResult
}

export interface RunFirefoxPortDeps {
  log?: (msg: string) => void
  cwd?: string
  env?: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
  discoverBinaries?: () => FirefoxBinary[]
  launchFirefox?: typeof launchFirefoxWithExtension
}

export async function runFirefoxPort(
  options: FirefoxPortOptions,
  deps: RunFirefoxPortDeps = {},
): Promise<FirefoxPortResult> {
  const log = deps.log ?? console.log
  const cwd = deps.cwd ?? process.cwd()

  // Fail fast before downloading/converting if --run cannot find a Firefox binary.
  let targetBrowser: FirefoxBinary | undefined
  if (options.run) {
    const discovered = (deps.discoverBinaries ?? discoverFirefoxBinaries)()
    targetBrowser = resolveFirefoxBinary(options.firefox, discovered)
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'extport-firefox-port-'))
  try {
    // 1. Resolve & unpack source
    const resolved = await resolveExtensionSource(options.source, workDir, {
      fetch: deps.fetch,
      env: deps.env,
      log,
    })

    // 2. Inspect manifest (MV3 enforcement, localized name, version, Firefox API warnings)
    const meta = await inspectFirefoxManifest(resolved.unpackedDir, resolved.fallbackName)
    log(`── extension: ${meta.appName} v${meta.version} (MV3) ──`)
    for (const warning of meta.warnings) {
      log(`⚠ ${warning.api}: ${warning.reason}`)
    }

    // 3. Stage a working copy when given a local directory so we never mutate the user's source
    const relToWork = path.relative(workDir, resolved.unpackedDir)
    const isInsideWorkDir = relToWork !== '' && !relToWork.startsWith('..') && !path.isAbsolute(relToWork)
    let stageDir = resolved.unpackedDir
    if (!isInsideWorkDir) {
      stageDir = path.join(workDir, 'staged')
      await copyDirectoryClean(resolved.unpackedDir, stageDir)
    }

    // 4. Patch manifest + inject Firefox runtime compatibility shim
    const geckoId =
      options.geckoId ??
      buildDeterministicGeckoId({
        cwsId: resolved.cwsId,
        appName: meta.appName,
        existingGeckoId: meta.existingGeckoId,
      })
    const minVersion = options.minVersion ?? meta.existingMinVersion ?? DEFAULT_FIREFOX_MIN_VERSION

    log(`── converting for Firefox (${geckoId}, min ${minVersion}) ──`)
    const { changes, patchedPages } = await patchExtensionForFirefox(stageDir, {
      geckoId,
      minVersion: options.minVersion ?? (meta.existingMinVersion ? undefined : DEFAULT_FIREFOX_MIN_VERSION),
    })
    if (options.debug && changes.length > 0) {
      log(`── manifest transforms: ${changes.join(', ')} ──`)
    }
    if (options.debug && patchedPages.length > 0) {
      log(`── injected Firefox runtime shim into: ${patchedPages.join(', ')} ──`)
    }

    // 5. Optionally keep converted unpacked directory
    let keptUnpackedPath: string | undefined
    if (options.keepUnpacked) {
      keptUnpackedPath = path.resolve(cwd, options.keepUnpacked)
      await copyDirectoryClean(stageDir, keptUnpackedPath)
      log(`── kept unpacked Firefox extension at ${keptUnpackedPath} ──`)
    }

    // 6. Export .xpi (or unpacked directory) unless --run was passed without --output
    let outputPath: string | undefined
    const shouldExport = !options.run || Boolean(options.output)
    if (shouldExport) {
      const slug = slugifyFilename(meta.appName, resolved.cwsId ?? resolved.fallbackName)
      outputPath = resolveFirefoxOutputPath({
        output: options.output,
        cwd,
        slug,
        unpacked: options.unpacked,
      })
      if (options.unpacked) {
        await copyDirectoryClean(stageDir, outputPath)
        log(`✅ Exported unpacked Firefox extension to ${outputPath}`)
        log('Next: open about:debugging#/runtime/this-firefox → Load Temporary Add-on… and select manifest.json')
      } else {
        const sizeBytes = await packageXpi(stageDir, outputPath)
        const kb = (sizeBytes / 1024).toFixed(1)
        log(`✅ Exported Firefox extension to ${outputPath} (${kb} KB)`)
        log('Next:')
        log(
          '  • Try immediately in any Firefox: re-run with --run, or open about:debugging#/runtime/this-firefox → Load Temporary Add-on…',
        )
        log(
          '  • Install permanently in Firefox Developer Edition / Nightly / Zen / Waterfox / LibreWolf: set xpinstall.signatures.required=false in about:config and drag the .xpi into the browser',
        )
      }
    }

    // 7. Optionally launch Firefox and install temporary add-on via RDP
    let runResult: RdpAddonInstallResult | undefined
    if (options.run && targetBrowser) {
      const launcher = deps.launchFirefox ?? launchFirefoxWithExtension
      runResult = await launcher({
        binary: targetBrowser,
        unpackedDir: stageDir,
        log,
        debug: options.debug,
      })
    }

    return {
      appName: meta.appName,
      version: meta.version,
      geckoId,
      minVersion,
      changes,
      patchedPages,
      outputPath,
      keptUnpackedPath,
      runResult,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
