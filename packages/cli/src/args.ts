export interface PushOptions {
  /** Omitted only for --store safari — the binary already reached the store out-of-band. */
  file?: string
  extension: string
  version: string
  store?: string
  /** Firefox only — AMO requires source for bundled/minified submissions. */
  sourceZip?: string
  apiUrl: string
  apiKey: string
}

/** citty's parsed shape for the `push` command — kebab flags read back camelCase. */
export interface RawPushArgs {
  file?: string
  extension?: string
  version?: string
  store?: string
  sourceZip?: string
  apiUrl?: string
  apiKey?: string
}

/**
 * Falls back to `extport login`'s saved key, extport.config.json's
 * extension/apiUrl, and — for a WXT project — the zip's conventional
 * .output/ path and the version read out of it (see wxt-project.ts).
 */
export interface PushDefaults {
  extension?: string
  apiKey?: string
  apiUrl?: string
  file?: string
  version?: string
  sourceZip?: string
}

export interface PushContext {
  extension: string
  apiUrl: string
  apiKey: string
}

/**
 * Just the fields needed before a file/version are even known — used by the
 * "no --file and no --store" auto mode to authenticate and look up the
 * extension's configured targets before resolving each one individually.
 */
export function resolvePushContext(raw: Pick<RawPushArgs, 'extension' | 'apiUrl' | 'apiKey'>, env: Record<string, string | undefined>, defaults: PushDefaults = {}): PushContext {
  const extension = raw.extension ?? defaults.extension
  if (!extension) throw new Error('--extension is required')
  const apiKey = raw.apiKey ?? env.EXTPORT_API_KEY ?? defaults.apiKey
  if (!apiKey) throw new Error('missing API key: run `extport login`, or set EXTPORT_API_KEY / pass --api-key')
  const apiUrl = (raw.apiUrl ?? env.EXTPORT_API_URL ?? defaults.apiUrl ?? 'https://dash.extport.dev').replace(/\/+$/, '')
  return { extension, apiUrl, apiKey }
}

/**
 * citty's declarative `args` handles shape (flag names, --store's enum) and
 * --help/--version for free; what's left here is the validation citty can't
 * express — cross-field rules (source-zip needs --store firefox), the
 * flag > env > defaults precedence chain, and the version format check.
 */
export function resolvePushOptions(raw: RawPushArgs, env: Record<string, string | undefined>, defaults: PushDefaults = {}): PushOptions {
  const file = raw.file ?? defaults.file
  if (!file && raw.store !== 'safari') {
    throw new Error('missing zip file argument (only --store safari can be pushed without one)')
  }

  const version = raw.version ?? defaults.version
  if (!version || !/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Error('--version is required and must be 1-4 dot-separated integers')
  }

  if (raw.sourceZip !== undefined && raw.store !== 'firefox') {
    throw new Error('--source-zip is only valid with --store firefox')
  }
  // The inferred default is firefox-only by construction (wxt-project.ts),
  // but guard here too so a stray default can never leak to another store.
  const sourceZip = raw.sourceZip ?? (raw.store === 'firefox' ? defaults.sourceZip : undefined)

  const { extension, apiUrl, apiKey } = resolvePushContext(raw, env, defaults)
  return { file, extension, version, store: raw.store, sourceZip, apiUrl, apiKey }
}

export function buildPushUrl(options: PushOptions): string {
  const url = new URL('/api/v1/artifacts', options.apiUrl)
  url.searchParams.set('extension', options.extension)
  url.searchParams.set('version', options.version)
  if (options.store) url.searchParams.set('store', options.store)
  return url.toString()
}
