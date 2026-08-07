import fs from 'node:fs/promises'
import path from 'node:path'
import { capture, run } from './exec'
import { writeSetupPage } from './safari-setup-page'

export type SafariProjectType = 'macos' | 'ios' | 'both'

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
 * Runs `xcrun safari-web-extension-converter`, then patches the generated
 * project (version, category, team, bundle ids) to match what `extport
 * safari-build` expects to find, and replaces the placeholder host-app page
 * with a real setup guide.
 */
export async function convertToXcodeProject(opts: ConvertToXcodeProjectOptions & { log?: (msg: string) => void }): Promise<void> {
  const flags = ['--force', '--no-prompt']
  if (opts.projectType === 'ios') flags.push('--ios-only')
  if (opts.projectType === 'macos') flags.push('--macos-only')
  if (!opts.openProject) flags.push('--no-open')

  await run(
    'xcrun',
    ['safari-web-extension-converter', '--bundle-identifier', opts.bundleIdentifier, '--project-location', '.output', ...flags, `.output/safari-mv${opts.manifestVersion}`],
    { cwd: opts.rootPath },
  )

  await updateProjectConfig(opts)
  await updateInfoPlist(opts)

  // Cosmetic: a failure here must not fail an otherwise good build.
  const wrote = await writeSetupPage({
    projectName: opts.projectName,
    projectRoot: path.resolve(opts.rootPath, projectDir(opts)),
  })
  if (!wrote) opts.log?.("couldn't find the host app's Resources directory — left the generated setup page in place")
}

interface PostBuildOptions {
  projectName: string
  appCategory: string
  bundleIdentifier: string
  developmentTeam?: string
  rootPath: string
}

/**
 * The converter names the project directory after the manifest's `name`
 * verbatim — spaces, hyphens and all — and projectName is resolved from that
 * same manifest, so this is always where the project landed.
 */
function projectDir(options: PostBuildOptions): string {
  return `.output/${options.projectName}`
}

async function updateProjectConfig(options: PostBuildOptions): Promise<void> {
  const projectConfigPath = path.resolve(options.rootPath, `${projectDir(options)}/${options.projectName}.xcodeproj/project.pbxproj`)
  const packageJsonModule = await import(path.resolve(options.rootPath, 'package.json'), { with: { type: 'json' } })
  const packageJson = packageJsonModule.default as { version: string }
  const content = await fs.readFile(projectConfigPath, 'utf-8')
  const desired = resolveBundleIds(await readPbxObjects(projectConfigPath), options.bundleIdentifier)
  const newContent = applyBundleIds(content, desired)
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
  const projectPath = path.resolve(options.rootPath, projectDir(options))
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

function quote(value: string): string {
  return /^[A-Za-z0-9._]+$/.test(value) ? value : `"${value}"`
}

const PRODUCT_TYPE_APPLICATION = 'com.apple.product-type.application'
const PRODUCT_TYPE_APP_EXTENSION = 'com.apple.product-type.app-extension'
/** What the converter itself uses, and what it writes into ViewController.swift. */
const EXTENSION_SUFFIX = '.Extension'

/** One entry of a pbxproj's flat `objects` map, as plutil hands it back. */
interface PbxObject {
  isa?: string
  productType?: string
  buildConfigurationList?: string
  buildConfigurations?: string[]
}

/** A `};` at two tabs closes a top-level object; nested lists and dicts are deeper. */
const BUILD_CONFIG_BLOCK = /([0-9A-Fa-f]{24}) \/\* \w+ \*\/ = \{\s*isa = XCBuildConfiguration;[\s\S]*?\n\t\t\};/g
const SINGLE_BUNDLE_ID = /PRODUCT_BUNDLE_IDENTIFIER = ("[^"]*"|[^;]+);/

/**
 * A pbxproj is an OpenStep property list, so Apple's own parser reads it
 * natively. Going through plutil means the project's structure is never
 * something we infer — if the format shifts, plutil shifts with it.
 */
export async function readPbxObjects(pbxprojPath: string): Promise<Record<string, PbxObject>> {
  const json = await capture('plutil', ['-convert', 'json', '-o', '-', pbxprojPath])
  return (JSON.parse(json) as { objects?: Record<string, PbxObject> }).objects ?? {}
}

/**
 * Which bundle id each XCBuildConfiguration must end up with: the app's
 * configurations get the configured bundleIdentifier, its extension's get that
 * plus `.Extension`. Resolved by walking target -> configuration list ->
 * configurations, all by object id.
 *
 * Deriving the suffix rather than preserving whatever is there is deliberate:
 * a mangled id carries no suffix worth keeping, and `.Extension` is the
 * converter's own convention — the same one it hardcodes into
 * ViewController.swift's `extensionBundleIdentifier`, which is what makes the
 * app's extension-state check line up.
 */
export function resolveBundleIds(objects: Record<string, PbxObject>, bundleIdentifier: string): Map<string, string> {
  const desired = new Map<string, string>()
  for (const target of Object.values(objects)) {
    if (target.isa !== 'PBXNativeTarget' || !target.buildConfigurationList) continue

    const id =
      target.productType === PRODUCT_TYPE_APPLICATION
        ? bundleIdentifier
        : target.productType === PRODUCT_TYPE_APP_EXTENSION
          ? bundleIdentifier + EXTENSION_SUFFIX
          : undefined
    if (!id) continue

    const list = objects[target.buildConfigurationList]
    if (list?.isa !== 'XCConfigurationList') continue
    for (const configId of list.buildConfigurations ?? []) desired.set(configId, id)
  }
  return desired
}

/**
 * Rewrite only the configurations named in `desired`, in place. Editing the
 * text rather than re-serialising the whole plist keeps the file's comments
 * and formatting — plutil can't emit OpenStep back anyway, and a full rewrite
 * would turn every build into an unreviewable diff.
 *
 * Why this is needed at all: `xcrun safari-web-extension-converter` does not
 * reliably honour `--bundle-identifier`. It renames targets after the
 * *project*, and which ones it mangles varies with the Xcode version and the
 * `--ios-only`/`--macos-only` flag. Observed on gmail-notifier (2026-08-07):
 * the app became `com.rxliuli.Inbox-Notifier-for-Gmail` (from the display
 * name) while the extension got the raw `--bundle-identifier` with no suffix,
 * so Xcode refused to build — "Embedded binary's bundle identifier is not
 * prefixed with the parent app's".
 */
export function applyBundleIds(content: string, desired: Map<string, string>): string {
  // Nothing resolved means the structure didn't parse; leaving a working
  // project alone beats rewriting ids on a guess.
  if (desired.size === 0) return content

  return content.replace(BUILD_CONFIG_BLOCK, (block, configId: string) => {
    const want = desired.get(configId)
    if (!want) return block
    return block.replace(SINGLE_BUNDLE_ID, `PRODUCT_BUNDLE_IDENTIFIER = ${quote(want)};`)
  })
}
