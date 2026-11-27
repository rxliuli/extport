import path from 'node:path'
import {
  applyBundleIds,
  convertExtensionToXcodeProject,
  parseProjectVersion,
  readPbxObjects,
  resolveBundleIds,
  type SafariProjectType,
} from '@extport/safari-xcode'

export { applyBundleIds, parseProjectVersion, readPbxObjects, resolveBundleIds, type SafariProjectType }

export interface ConvertToXcodeProjectOptions {
  projectName: string
  appCategory: string
  bundleIdentifier: string
  developmentTeam?: string
  projectType: SafariProjectType
  openProject: boolean
  rootPath: string
  manifestVersion: number
}

/**
 * Runs `xcrun safari-web-extension-converter` for a WXT build output, then
 * patches the generated project (version, category, team, bundle ids) and
 * installs the custom setup page.
 */
export async function convertToXcodeProject(
  opts: ConvertToXcodeProjectOptions & { log?: (msg: string) => void },
): Promise<void> {
  const packageJsonModule = await import(path.resolve(opts.rootPath, 'package.json'), { with: { type: 'json' } })
  const packageJson = packageJsonModule.default as { version: string }

  await convertExtensionToXcodeProject({
    sourceDir: `.output/safari-mv${opts.manifestVersion}`,
    outputDir: '.output',
    projectName: opts.projectName,
    version: packageJson.version,
    appCategory: opts.appCategory,
    bundleIdentifier: opts.bundleIdentifier,
    developmentTeam: opts.developmentTeam,
    projectType: opts.projectType,
    openProject: opts.openProject,
    cwd: opts.rootPath,
    stream: true,
    log: opts.log,
  })
}
