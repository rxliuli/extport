import fs from 'node:fs/promises'
import path from 'node:path'
import { capture, run } from './exec'
import { writeSetupPage } from './safari-setup-page'
import { parseXcproj, patchXcproj, serializeXcproj } from './safari-xcproj'

export type SafariProjectType = 'macos' | 'ios' | 'both'

export interface ConvertExtensionToXcodeProjectOptions {
  /** Path to the unpacked web extension directory containing manifest.json. */
  sourceDir: string
  /** Parent directory passed to `--project-location`. */
  outputDir: string
  /** Expected project / app display name. */
  projectName: string
  /** Marketing version string (e.g. "1.2.3"). */
  version: string
  appCategory: string
  bundleIdentifier: string
  developmentTeam?: string
  projectType: SafariProjectType
  openProject: boolean
  /** Explicitly pass `--app-name` to the converter (recommended when manifest.name is localized or sanitized). */
  appName?: string
  /** Pass `--copy-resources` so the generated Xcode project is self-contained. */
  copyResources?: boolean
  /** Stream converter stdout/stderr live (default: true). */
  stream?: boolean
  cwd?: string
  log?: (msg: string) => void
}

export interface ConvertedXcodeProject {
  projectDir: string
  xcodeprojPath: string
  projectName: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

/**
 * Locate the generated `<Name>/<Name>.xcodeproj` inside `outputDir`. Prefers
 * the expected `projectName` directory and falls back to scanning `outputDir`
 * if the converter sanitized or adjusted the folder name.
 */
async function locateGeneratedProject(outputDir: string, expectedName: string): Promise<ConvertedXcodeProject> {
  const expectedDir = path.join(outputDir, expectedName)
  const expectedProj = path.join(expectedDir, `${expectedName}.xcodeproj`)
  if (await exists(expectedProj)) {
    return { projectDir: expectedDir, xcodeprojPath: expectedProj, projectName: expectedName }
  }

  const entries = await fs.readdir(outputDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidateDir = path.join(outputDir, entry.name)
    const inner = await fs.readdir(candidateDir)
    const xcodeproj = inner.find((name) => name.endsWith('.xcodeproj'))
    if (xcodeproj) {
      return {
        projectDir: candidateDir,
        xcodeprojPath: path.join(candidateDir, xcodeproj),
        projectName: xcodeproj.slice(0, -'.xcodeproj'.length),
      }
    }
  }

  throw new Error(`could not find generated .xcodeproj under ${outputDir}`)
}

/**
 * Runs `xcrun safari-web-extension-converter`, patches the generated project
 * (version, category, team, bundle ids) for both OpenStep `project.pbxproj`
 * and Xcode 27.2 JSON `project.xcproj`, and replaces the placeholder host-app
 * page with a real setup guide.
 */
export async function convertExtensionToXcodeProject(
  opts: ConvertExtensionToXcodeProjectOptions,
): Promise<ConvertedXcodeProject> {
  const args = [
    'safari-web-extension-converter',
    '--bundle-identifier',
    opts.bundleIdentifier,
    '--project-location',
    opts.outputDir,
  ]
  if (opts.appName) args.push('--app-name', opts.appName)
  if (opts.copyResources) args.push('--copy-resources')
  args.push('--force', '--no-prompt')
  if (opts.projectType === 'ios') args.push('--ios-only')
  if (opts.projectType === 'macos') args.push('--macos-only')
  if (!opts.openProject) args.push('--no-open')
  args.push(opts.sourceDir)

  await run('xcrun', args, { cwd: opts.cwd, stream: opts.stream })

  const resolvedOutputDir = opts.cwd ? path.resolve(opts.cwd, opts.outputDir) : path.resolve(opts.outputDir)
  const located = await locateGeneratedProject(resolvedOutputDir, opts.appName ?? opts.projectName)

  await updateProjectConfig({
    projectName: located.projectName,
    xcodeprojPath: located.xcodeprojPath,
    version: opts.version,
    appCategory: opts.appCategory,
    bundleIdentifier: opts.bundleIdentifier,
    developmentTeam: opts.developmentTeam,
  })
  await updateInfoPlist(located.projectDir)

  // Cosmetic: a failure here must not fail an otherwise good build.
  const wrote = await writeSetupPage({
    projectName: located.projectName,
    projectRoot: located.projectDir,
  })
  if (!wrote) opts.log?.("couldn't find the host app's Resources directory — left the generated setup page in place")

  return located
}

interface PatchProjectOptions {
  projectName: string
  xcodeprojPath: string
  version: string
  appCategory: string
  bundleIdentifier: string
  developmentTeam?: string
}

/**
 * Xcode 27.2 and later generate new projects in the JSON `project.xcproj`
 * format; earlier versions write the OpenStep `project.pbxproj`. Which one the
 * converter produced depends only on the Xcode that ran it, so look rather
 * than guess from a version number.
 */
async function updateProjectConfig(options: PatchProjectOptions): Promise<void> {
  const projectVersion = parseProjectVersion(options.version)
  const xcprojPath = path.join(options.xcodeprojPath, 'project.xcproj')
  if (await exists(xcprojPath)) {
    const project = patchXcproj(parseXcproj(await fs.readFile(xcprojPath, 'utf-8')), {
      appCategory: options.appCategory,
      bundleIdentifier: options.bundleIdentifier,
      developmentTeam: options.developmentTeam,
      version: options.version,
      projectVersion,
    })
    await fs.writeFile(xcprojPath, serializeXcproj(project))
    return
  }

  const projectConfigPath = path.join(options.xcodeprojPath, 'project.pbxproj')
  const content = await fs.readFile(projectConfigPath, 'utf-8')
  const desired = resolveBundleIds(await readPbxObjects(projectConfigPath), options.bundleIdentifier)
  const escapedName = escapeRegExp(options.projectName)
  const newContent = applyBundleIds(content, desired)
    .replaceAll('MARKETING_VERSION = 1.0;', `MARKETING_VERSION = ${options.version};`)
    .replace(
      new RegExp(`INFOPLIST_KEY_CFBundleDisplayName = ("?${escapedName}"?);`, 'g'),
      `INFOPLIST_KEY_CFBundleDisplayName = $1;\n\t\t\t\tINFOPLIST_KEY_LSApplicationCategoryType = "${options.appCategory}";`,
    )
    .replace(
      /GCC_WARN_UNUSED_VARIABLE = YES;/g,
      `GCC_WARN_UNUSED_VARIABLE = YES;\n\t\t\t\tINFOPLIST_KEY_LSApplicationCategoryType = "${options.appCategory}";`,
    )
    .replace(
      new RegExp(`INFOPLIST_KEY_CFBundleDisplayName = ("?${escapedName}"?);`, 'g'),
      `INFOPLIST_KEY_CFBundleDisplayName = $1;\n\t\t\t\tINFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO;`,
    )
    .replaceAll(
      'COPY_PHASE_STRIP = NO;',
      options.developmentTeam
        ? `COPY_PHASE_STRIP = NO;\n\t\t\t\tDEVELOPMENT_TEAM = ${options.developmentTeam};`
        : 'COPY_PHASE_STRIP = NO;',
    )
    .replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${projectVersion};`)
  await fs.writeFile(projectConfigPath, newContent)
}

async function updateInfoPlist(projectDir: string): Promise<void> {
  const files = await findPlistFiles(projectDir)
  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8')
    if (content.includes('<key>CFBundleVersion</key>')) continue
    await fs.writeFile(
      file,
      content.replaceAll(
        '</dict>\n</plist>',
        '\t<key>CFBundleVersion</key>\n\t<string>$(CURRENT_PROJECT_VERSION)</string>\n</dict>\n</plist>',
      ),
    )
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
  const parts = version.split('.').map((part) => Number.parseInt(part, 10))
  const major = Number.isFinite(parts[0]) ? parts[0]! : 0
  const minor = Number.isFinite(parts[1]) ? parts[1]! : 0
  const patch = Number.isFinite(parts[2]) ? parts[2]! : 0
  return Math.max(1, major * 10000 + minor * 100 + patch)
}

function quote(value: string): string {
  return /^[A-Za-z0-9._]+$/.test(value) ? value : `"${value}"`
}

const PRODUCT_TYPE_APPLICATION = 'com.apple.product-type.application'
const PRODUCT_TYPE_APP_EXTENSION = 'com.apple.product-type.app-extension'
/** What the converter itself uses, and what it writes into ViewController.swift. */
const EXTENSION_SUFFIX = '.Extension'

/** One entry of a pbxproj's flat `objects` map, as plutil hands it back. */
export interface PbxObject {
  isa?: string
  productType?: string
  buildConfigurationList?: string
  buildConfigurations?: string[]
}

/**
 * A `};` at two tabs closes a top-level object; nested lists and dicts are
 * deeper. The id's trailing comment is optional and its content doesn't
 * matter: older Xcode writes a bare config name there (e.g. "Debug"), while
 * Xcode 27 writes a full sentence instead (observed on gmail-notifier
 * 2026-10-02: `Debug configuration for PBXNativeTarget "Inbox Notifier for
 * Gmail"`). Either way the block is already keyed by the 24-hex object id,
 * which is all `resolveBundleIds` ever hands back.
 */
const BUILD_CONFIG_BLOCK = /([0-9A-Fa-f]{24})(?: \/\*[^*]*\*\/)? = \{\s*isa = XCBuildConfiguration;[\s\S]*?\n\t\t\};/g
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
 * Rewrite only the configurations named in `desired`, in place.
 */
export function applyBundleIds(content: string, desired: Map<string, string>): string {
  if (desired.size === 0) return content

  return content.replace(BUILD_CONFIG_BLOCK, (block, configId: string) => {
    const want = desired.get(configId)
    if (!want) return block
    return block.replace(SINGLE_BUNDLE_ID, `PRODUCT_BUNDLE_IDENTIFIER = ${quote(want)};`)
  })
}
