import 'wxt'
import fs from 'node:fs/promises'
import { defineWxtModule } from 'wxt/modules'
import { convertToXcodeProject, type SafariProjectType } from './safari-xcode'
import { loadProjectConfig, saveProjectConfig, syncSafariConfig } from './project-config'

export interface ExtportWxtOptions {
  /** Safari project name. Defaults to manifest.name, then package.json's name. */
  projectName?: string
  /** App category, e.g. 'public.app-category.productivity'. */
  appCategory: string
  /** Bundle identifier, e.g. 'com.example.your-extension'. */
  bundleIdentifier: string
  /** Apple Developer Team ID. If set, also written to extport.config.json's safari.teamId. */
  developmentTeam?: string
  /** Output path for the Xcode project. Defaults to '.output/{projectName}'. */
  outputPath?: string
  /** Defaults to 'both' (macOS and iOS). */
  projectType?: SafariProjectType
  /** Open the Xcode project after creation. Defaults to true; set false in CI. */
  openProject?: boolean
}

export default defineWxtModule<ExtportWxtOptions>({
  name: 'extport',
  configKey: 'extport',
  async setup(wxt, options) {
    // Only execute when building for Safari.
    if (wxt.config.browser !== 'safari') return

    const { appCategory, bundleIdentifier, developmentTeam } = options ?? {}

    const projectName =
      options?.projectName ?? wxt.config.manifest.name ?? (await fs.readFile(`${wxt.config.root}/package.json`, 'utf-8').then((data) => JSON.parse(data).name))

    if (!projectName || !appCategory || !bundleIdentifier) {
      wxt.logger.warn('@extport/wxt is not configured properly. Please provide projectName, appCategory and bundleIdentifier under the "extport" key.')
      return
    }

    const packageJsonRaw = await fs.readFile(`${wxt.config.root}/package.json`, 'utf-8')
    if (!JSON.parse(packageJsonRaw).version) {
      throw new Error('@extport/wxt: package.json is missing a "version" field. Add a version (e.g. "0.1.0") so the Xcode project can be configured.')
    }

    const outputPath = options?.outputPath ?? `.output/${projectName}`
    const projectType = options?.projectType ?? 'both'
    const openProject = options?.openProject ?? true

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
          outputPath,
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

      const projectConfig = await loadProjectConfig(wxt.config.root)
      const { config, changed } = syncSafariConfig(projectConfig, { projectPath: outputPath, teamId: developmentTeam })
      if (changed) {
        await saveProjectConfig(config, wxt.config.root)
        wxt.logger.info(`Synced extport.config.json (safari.projectPath${developmentTeam ? '/teamId' : ''}).`)
      }
    })
  },
})

declare module 'wxt' {
  export interface InlineConfig {
    extport?: ExtportWxtOptions
  }
}
