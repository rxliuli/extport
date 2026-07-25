import fs from 'node:fs/promises'
import path from 'node:path'
import { run } from './exec'

export type SafariProjectType = 'macos' | 'ios' | 'both'

export interface ConvertToXcodeProjectOptions {
  projectName: string
  appCategory: string
  bundleIdentifier: string
  developmentTeam?: string
  outputPath: string
  projectType: SafariProjectType
  openProject: boolean
  rootPath: string
  manifestVersion: number
}

/**
 * Runs `xcrun safari-web-extension-converter` and moves the result to
 * `outputPath`, then patches the generated project (version, category,
 * team, bundle ids) to match what `extport safari-build` expects to find.
 */
export async function convertToXcodeProject(opts: ConvertToXcodeProjectOptions): Promise<void> {
  const flags = ['--force', '--no-prompt']
  if (opts.projectType === 'ios') flags.push('--ios-only')
  if (opts.projectType === 'macos') flags.push('--macos-only')
  if (!opts.openProject) flags.push('--no-open')

  await run(
    'xcrun',
    ['safari-web-extension-converter', '--bundle-identifier', opts.bundleIdentifier, '--project-location', '.output', ...flags, `.output/safari-mv${opts.manifestVersion}`],
    { cwd: opts.rootPath },
  )

  const defaultOutputPath = `.output/${opts.projectName}`
  if (opts.outputPath !== defaultOutputPath) {
    await fs.rename(path.resolve(opts.rootPath, defaultOutputPath), path.resolve(opts.rootPath, opts.outputPath))
  }

  await updateProjectConfig(opts)
  await updateInfoPlist(opts)
}

interface PostBuildOptions {
  projectName: string
  appCategory: string
  bundleIdentifier: string
  developmentTeam?: string
  outputPath: string
  rootPath: string
}

async function updateProjectConfig(options: PostBuildOptions): Promise<void> {
  const projectConfigPath = path.resolve(options.rootPath, `${options.outputPath}/${options.projectName}.xcodeproj/project.pbxproj`)
  const packageJsonModule = await import(path.resolve(options.rootPath, 'package.json'), { with: { type: 'json' } })
  const packageJson = packageJsonModule.default as { version: string }
  const content = await fs.readFile(projectConfigPath, 'utf-8')
  const newContent = normaliseBundleIds(content, options.bundleIdentifier)
    .replaceAll('MARKETING_VERSION = 1.0;', `MARKETING_VERSION = ${packageJson.version};`)
    .replace(
      new RegExp(`INFOPLIST_KEY_CFBundleDisplayName = ("?${options.projectName}"?);`, 'g'),
      `INFOPLIST_KEY_CFBundleDisplayName = $1;\n\t\t\t\tINFOPLIST_KEY_LSApplicationCategoryType = "${options.appCategory}";`,
    )
    .replace(
      new RegExp(`GCC_WARN_UNUSED_VARIABLE = YES;`, 'g'),
      `GCC_WARN_UNUSED_VARIABLE = YES;\n\t\t\t\tINFOPLIST_KEY_LSApplicationCategoryType = "${options.appCategory}";`,
    )
    .replace(
      new RegExp(`INFOPLIST_KEY_CFBundleDisplayName = ("?${options.projectName}"?);`, 'g'),
      `INFOPLIST_KEY_CFBundleDisplayName = $1;\n\t\t\t\tINFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO;`,
    )
    .replaceAll(`COPY_PHASE_STRIP = NO;`, options.developmentTeam ? `COPY_PHASE_STRIP = NO;\n\t\t\t\tDEVELOPMENT_TEAM = ${options.developmentTeam};` : 'COPY_PHASE_STRIP = NO;')
    .replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${parseProjectVersion(packageJson.version)};`)
  await fs.writeFile(projectConfigPath, newContent)
}

async function updateInfoPlist(options: PostBuildOptions): Promise<void> {
  const projectPath = path.resolve(options.rootPath, options.outputPath)
  const files = await findPlistFiles(projectPath)
  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8')
    await fs.writeFile(file, content.replaceAll('</dict>\n</plist>', '\t<key>CFBundleVersion</key>\n\t<string>$(CURRENT_PROJECT_VERSION)</string>\n</dict>\n</plist>'))
  }
}

async function findPlistFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) results.push(...(await findPlistFiles(full)))
    else if (entry.isFile() && entry.name.endsWith('.plist')) results.push(full)
  }
  return results
}

export function parseProjectVersion(version: string): number {
  const [major, minor, patch] = version.split('.').map(Number)
  return major! * 10000 + minor! * 100 + patch!
}

const BUNDLE_ID_REGEX = /PRODUCT_BUNDLE_IDENTIFIER = ("[^"]*"|[^;]+);/g

function unwrap(raw: string): string {
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
}

function quote(value: string): string {
  return /^[A-Za-z0-9._]+$/.test(value) ? value : `"${value}"`
}

/**
 * Normalise every PRODUCT_BUNDLE_IDENTIFIER so the parent app's id matches
 * the user-supplied bundleIdentifier and sub-targets share that prefix.
 *
 * Apple's `xcrun safari-web-extension-converter` sometimes mangles the
 * parent app's id (e.g. uppercasing the last segment to match the project
 * name) while leaving sub-target ids alone — or vice versa — depending on
 * Xcode version and which `--ios-only`/`--macos-only` flag was passed. The
 * resulting prefix mismatch makes Xcode refuse the build with "Embedded
 * binary's bundle identifier is not prefixed with the parent app's".
 *
 * Strategy: the shortest unique id in the pbxproj is the parent app's
 * (Apple-mangled) stem; sub-targets append a suffix to it. Replace that
 * stem everywhere with the user-supplied bundleIdentifier, preserving any
 * suffix (`.Extension`, ` Extension`, etc.).
 */
export function normaliseBundleIds(content: string, bundleIdentifier: string): string {
  const ids = [...content.matchAll(BUNDLE_ID_REGEX)].map((m) => unwrap(m[1]!))
  if (ids.length === 0) return content

  const stem = [...new Set(ids)].sort((a, b) => a.length - b.length)[0]
  if (!stem || stem === bundleIdentifier) return content

  return content.replace(BUNDLE_ID_REGEX, (match, raw: string) => {
    const id = unwrap(raw)
    if (!id.startsWith(stem)) return match
    const newId = bundleIdentifier + id.slice(stem.length)
    return `PRODUCT_BUNDLE_IDENTIFIER = ${quote(newId)};`
  })
}
