export declare function setupPageHtml(projectName: string): string;
export declare function setupPageCss(): string;
export declare function setupPageScript(): string;
/**
 * The converter sizes the macOS window for its one-sentence placeholder, which
 * clips the guide. Both the window's contentRect and the view/webview frames
 * carry the same height, so a plain substitution covers all of them.
 */
export declare function resizeMacWindow(storyboard: string, from?: number, to?: number): string;
/**
 * Converting for both platforms groups sources under `Shared (App)`/`macOS
 * (App)`; converting for one platform lays them out flat under the project
 * name. Probe rather than infer from projectType — the layout is the
 * converter's decision, and this stays correct if that changes.
 */
export declare function resolveAppPaths(projectRoot: string, projectName: string): Promise<{
    resources: string;
    macStoryboard: string;
} | undefined>;
export interface WriteSetupPageOptions {
    projectName: string;
    projectRoot: string;
}
/** Returns false when the expected layout isn't there, so the caller can warn without failing the build. */
export declare function writeSetupPage(options: WriteSetupPageOptions): Promise<boolean>;
