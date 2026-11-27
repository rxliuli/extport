export type SafariProjectType = 'macos' | 'ios' | 'both';
export interface ConvertExtensionToXcodeProjectOptions {
    /** Path to the unpacked web extension directory containing manifest.json. */
    sourceDir: string;
    /** Parent directory passed to `--project-location`. */
    outputDir: string;
    /** Expected project / app display name. */
    projectName: string;
    /** Marketing version string (e.g. "1.2.3"). */
    version: string;
    appCategory: string;
    bundleIdentifier: string;
    developmentTeam?: string;
    projectType: SafariProjectType;
    openProject: boolean;
    /** Explicitly pass `--app-name` to the converter (recommended when manifest.name is localized or sanitized). */
    appName?: string;
    /** Pass `--copy-resources` so the generated Xcode project is self-contained. */
    copyResources?: boolean;
    /** Stream converter stdout/stderr live (default: true). */
    stream?: boolean;
    cwd?: string;
    log?: (msg: string) => void;
}
export interface ConvertedXcodeProject {
    projectDir: string;
    xcodeprojPath: string;
    projectName: string;
}
/**
 * Runs `xcrun safari-web-extension-converter`, patches the generated project
 * (version, category, team, bundle ids) for both OpenStep `project.pbxproj`
 * and Xcode 27.2 JSON `project.xcproj`, and replaces the placeholder host-app
 * page with a real setup guide.
 */
export declare function convertExtensionToXcodeProject(opts: ConvertExtensionToXcodeProjectOptions): Promise<ConvertedXcodeProject>;
export declare function parseProjectVersion(version: string): number;
/** One entry of a pbxproj's flat `objects` map, as plutil hands it back. */
export interface PbxObject {
    isa?: string;
    productType?: string;
    buildConfigurationList?: string;
    buildConfigurations?: string[];
}
/**
 * A pbxproj is an OpenStep property list, so Apple's own parser reads it
 * natively. Going through plutil means the project's structure is never
 * something we infer — if the format shifts, plutil shifts with it.
 */
export declare function readPbxObjects(pbxprojPath: string): Promise<Record<string, PbxObject>>;
/**
 * Which bundle id each XCBuildConfiguration must end up with: the app's
 * configurations get the configured bundleIdentifier, its extension's get that
 * plus `.Extension`. Resolved by walking target -> configuration list ->
 * configurations, all by object id.
 */
export declare function resolveBundleIds(objects: Record<string, PbxObject>, bundleIdentifier: string): Map<string, string>;
/**
 * Rewrite only the configurations named in `desired`, in place.
 */
export declare function applyBundleIds(content: string, desired: Map<string, string>): string;
