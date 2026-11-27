export interface RunOptions {
    cwd?: string;
    /** Stream stdio straight through (default: true). When false, capture output and include it in errors on failure. */
    stream?: boolean;
}
export declare function run(cmd: string, args: string[], options?: RunOptions): Promise<void>;
/** Captures stdout instead of streaming it — for tools whose output we parse rather than show. */
export declare function capture(cmd: string, args: string[], options?: {
    cwd?: string;
}): Promise<string>;
