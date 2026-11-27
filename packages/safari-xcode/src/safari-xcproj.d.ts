/**
 * Xcode 27.2's JSON project format (`project.xcproj`), which new projects —
 * including the ones `safari-web-extension-converter` generates — use in
 * place of the OpenStep `project.pbxproj`.
 *
 * Unlike a pbxproj this is plain data: targets carry their own
 * `build-settings` and a readable `product-type`, with no object ids to chase
 * and no comments to preserve. So it is parsed, edited as an object and
 * written back, rather than patched by text substitution.
 */
type BuildSettingValue = string | string[];
type BuildSettings = Record<string, BuildSettingValue>;
interface XcprojTarget {
    name?: string;
    'product-type'?: string;
    'build-settings'?: BuildSettings;
    [key: string]: unknown;
}
export interface XcprojProject {
    targets?: XcprojTarget[];
    'build-settings'?: BuildSettings;
    [key: string]: unknown;
}
export interface XcprojSettings {
    appCategory: string;
    bundleIdentifier: string;
    developmentTeam?: string;
    /** The extension's version, e.g. "1.2.3". */
    version: string;
    /** The build number derived from it. */
    projectVersion: number;
}
/**
 * Xcode writes the file with trailing commas, which JSON.parse rejects. Drop
 * the ones that sit before a closing bracket, leaving string contents alone.
 */
export declare function parseXcproj(text: string): XcprojProject;
export declare function serializeXcproj(project: XcprojProject): string;
/**
 * Apply to a parsed project what `updateProjectConfig` does to a pbxproj:
 * version and build number on every app and extension target, the store
 * metadata on the apps, the app's bundle id with its extension's derived from
 * it, and the category and team project-wide.
 *
 * The bundle ids are set rather than trusted for the same reason as in the
 * pbxproj path — the converter does not reliably honour `--bundle-identifier`,
 * and an extension whose id isn't prefixed with its app's won't build.
 */
export declare function patchXcproj(project: XcprojProject, settings: XcprojSettings): XcprojProject;
export {};
