import 'wxt'
import fs from 'node:fs/promises'
import { addViteConfig, addWxtPlugin, defineWxtModule } from 'wxt/modules'
import { convertToXcodeProject, type SafariProjectType } from './safari-xcode'
import { generateProjectConfig, loadProjectConfig, saveProjectConfig } from './project-config'

export interface ExtportSafariOptions {
  /** Safari project name. Defaults to manifest.name, then package.json's name. */
  projectName?: string
  /** App category, e.g. 'public.app-category.productivity'. */
  appCategory: string
  /** Bundle identifier, e.g. 'com.example.your-extension'. */
  bundleIdentifier: string
  /** Apple Developer Team ID. Written to extport.config.json's safari.teamId. */
  developmentTeam?: string
  /** App Store Connect API key issuer id — used by local `extport safari-build` (CI passes it as a secret). */
  issuerId?: string
  /** App Store Connect API key id — used by local `extport safari-build` (CI passes it as a secret). */
  keyId?: string
  /** Output path for the Xcode project. Defaults to '.output/{projectName}'. */
  outputPath?: string
  /** Defaults to 'both' (macOS and iOS). */
  projectType?: SafariProjectType
  /** Open the Xcode project after creation. Defaults to true; set false in CI. */
  openProject?: boolean
}

export interface ExtportWxtOptions {
  /**
   * The extension's extport id (ext_…) — the single authored copy. Synced
   * into extport.config.json (the static interchange file the CLI and
   * GitHub Actions read; they can't execute wxt.config.ts) and injected at
   * runtime as `globalThis.__EXTPORT__.extensionId` so @extport/sdk resolves
   * it without any hardcoding.
   */
  extension?: string
  /**
   * Inject the daily anonymous usage ping (@extport/sdk/analytics
   * attachAnalytics, background only) and merge Firefox's
   * data_collection_permissions declaration into the manifest. Explicit
   * opt-in — a publishing module must never add telemetry silently.
   * Requires `extension` and `@extport/sdk` as a dependency.
   */
  analytics?: boolean
  safari?: ExtportSafariOptions
  /** @deprecated Move under `safari: {}`. */
  projectName?: string
  /** @deprecated Move under `safari: {}`. */
  appCategory?: string
  /** @deprecated Move under `safari: {}`. */
  bundleIdentifier?: string
  /** @deprecated Move under `safari: {}`. */
  developmentTeam?: string
  /** @deprecated Move under `safari: {}`. */
  outputPath?: string
  /** @deprecated Move under `safari: {}`. */
  projectType?: SafariProjectType
  /** @deprecated Move under `safari: {}`. */
  openProject?: boolean
}

const VIRTUAL_PLUGIN_ID = 'virtual:extport-plugin'

/**
 * Accept the pre-0.0.4 flat safari keys for one deprecation cycle. Pure so
 * it can be tested without booting WXT.
 */
export function normalizeOptions(options: ExtportWxtOptions | undefined): {
  extension?: string
  analytics: boolean
  safari?: ExtportSafariOptions
  usedLegacyKeys: boolean
} {
  const { extension, analytics, safari, ...legacy } = options ?? {}
  const hasLegacy = legacy.appCategory !== undefined || legacy.bundleIdentifier !== undefined
  return {
    extension,
    analytics: analytics ?? false,
    safari: safari ?? (hasLegacy ? (legacy as ExtportSafariOptions) : undefined),
    usedLegacyKeys: !safari && hasLegacy,
  }
}

/**
 * The source of the WXT plugin injected into every entrypoint, values
 * inlined as literals (generated first-party code — no reliance on define
 * replacement reaching dependency code). ENTRYPOINT is statically replaced
 * per entrypoint build, so the analytics branch (and its dynamic import,
 * which WXT inlines) is dead-code-eliminated everywhere but the background.
 */
export function pluginSource(extensionId: string, analytics: boolean): string {
  return [
    'export default function initExtport() {',
    `  globalThis.__EXTPORT__ = { extensionId: ${JSON.stringify(extensionId)} };`,
    ...(analytics
      ? [
          "  if (import.meta.env.ENTRYPOINT === 'background') {",
          "    void import('@extport/sdk/analytics')",
          '      .then((m) => { m.attachAnalytics() })',
          '      .catch((err) => { console.warn("[@extport/wxt] analytics unavailable:", err) });',
          '  }',
        ]
      : []),
    '}',
    '',
  ].join('\n')
}

/**
 * Merge the analytics data-collection declaration into a Firefox manifest.
 * technicalAndInteraction can only be `optional` (AMO rejects it in
 * required — user-declinable by design); existing declarations are
 * preserved, `required` defaults to ['none'] when the tenant has none.
 */
export function mergeDataCollectionPermissions(manifest: Record<string, unknown>): void {
  const bss = ((manifest.browser_specific_settings as Record<string, unknown> | undefined) ??= {})
  manifest.browser_specific_settings = bss
  const gecko = ((bss.gecko as Record<string, unknown> | undefined) ??= {})
  bss.gecko = gecko
  const dcp = ((gecko.data_collection_permissions as { required?: string[]; optional?: string[] } | undefined) ??= {})
  gecko.data_collection_permissions = dcp
  dcp.required ??= ['none']
  const optional = new Set(dcp.optional ?? [])
  optional.add('technicalAndInteraction')
  dcp.optional = [...optional]
}

export default defineWxtModule<ExtportWxtOptions>({
  name: 'extport',
  configKey: 'extport',
  async setup(wxt, options) {
    const { extension, analytics, safari, usedLegacyKeys } = normalizeOptions(options)
    if (usedLegacyKeys) {
      wxt.logger.warn(
        '@extport/wxt: top-level appCategory/bundleIdentifier/… are deprecated — move them under `extport: { safari: { … } }`.',
      )
    }

    // --- extport.config.json: fully generated here, at setup, so a plain
    // `pnpm install` (wxt prepare) leaves the file in its final state —
    // no fields appearing later at build time. Authored values win;
    // everything else (apiUrl, CLI-written history) passes through.
    const projectName =
      safari?.projectName ??
      wxt.config.manifest.name ??
      (await fs
        .readFile(`${wxt.config.root}/package.json`, 'utf-8')
        .then((data) => JSON.parse(data).name as string | undefined)
        .catch(() => undefined))
    const outputPath = safari?.outputPath ?? (projectName ? `.output/${projectName}` : undefined)

    if (extension || safari) {
      const existing = await loadProjectConfig(wxt.config.root)
      const { config, changed } = generateProjectConfig(existing, {
        extension,
        safari: safari
          ? { projectPath: outputPath, teamId: safari.developmentTeam, issuerId: safari.issuerId, keyId: safari.keyId }
          : undefined,
      })
      if (changed) {
        await saveProjectConfig(config, wxt.config.root)
        wxt.logger.info('Regenerated extport.config.json from wxt.config.ts.')
      }
    }

    // --- runtime injection: __EXTPORT__ global (+ background analytics).
    if (extension) {
      addViteConfig(wxt, () => ({
        plugins: [
          {
            name: 'extport:virtual-plugin',
            resolveId(id: string) {
              if (id === VIRTUAL_PLUGIN_ID) return '\0' + VIRTUAL_PLUGIN_ID
            },
            load(id: string) {
              if (id === '\0' + VIRTUAL_PLUGIN_ID) return pluginSource(extension, analytics)
            },
          },
        ],
      }))
      addWxtPlugin(wxt, VIRTUAL_PLUGIN_ID)
    } else if (analytics) {
      wxt.logger.warn('@extport/wxt: `analytics: true` requires `extension` — analytics not injected.')
    }

    // --- analytics: Firefox's built-in data-collection consent declaration.
    if (extension && analytics) {
      wxt.hook('build:manifestGenerated', (_wxt, manifest) => {
        if (wxt.config.browser !== 'firefox') return
        mergeDataCollectionPermissions(manifest as unknown as Record<string, unknown>)
      })
    }

    // --- Safari → Xcode conversion (safari builds only).
    if (wxt.config.browser !== 'safari') return
    if (!safari) return

    const { appCategory, bundleIdentifier, developmentTeam } = safari
    if (!projectName || !appCategory || !bundleIdentifier) {
      wxt.logger.warn(
        '@extport/wxt is not configured properly. Please provide projectName, appCategory and bundleIdentifier under the "extport.safari" key.',
      )
      return
    }

    const packageJsonRaw = await fs.readFile(`${wxt.config.root}/package.json`, 'utf-8')
    if (!JSON.parse(packageJsonRaw).version) {
      throw new Error(
        '@extport/wxt: package.json is missing a "version" field. Add a version (e.g. "0.1.0") so the Xcode project can be configured.',
      )
    }

    const projectType = safari.projectType ?? 'both'
    const openProject = safari.openProject ?? true

    wxt.hook('build:done', async (wxt) => {
      if (process.platform !== 'darwin') {
        const error = new Error('Safari Xcode conversion requires macOS.')
        wxt.logger.error('Safari Xcode conversion is only supported on macOS.', error)
        throw error
      }

      wxt.logger.info('Converting Safari extension to Xcode project...')
      try {
        await convertToXcodeProject({
          projectName,
          appCategory,
          bundleIdentifier,
          developmentTeam,
          outputPath: outputPath!,
          projectType,
          openProject,
          rootPath: wxt.config.root,
          manifestVersion: wxt.config.manifestVersion,
        })
        wxt.logger.success('Xcode project created successfully!')
      } catch (error) {
        wxt.logger.error('Safari Xcode conversion failed:', error)
        throw error
      }
    })
  },
})

declare module 'wxt' {
  export interface InlineConfig {
    extport?: ExtportWxtOptions
  }
}
