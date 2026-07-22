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

export const USAGE = `extport — publish browser extension artifacts

Usage:
  extport push <file.zip> --extension <id|slug> --version <x.y.z> [options]

Options:
  --extension <id|slug>   Target extension (required — or extport.config.json's "extension")
  --version <x.y.z>       Artifact version, 1-4 numeric parts (required)
  --store <name>          chrome | firefox | edge | safari (omit for a universal zip)
  --source-zip <file.zip> Source code zip for AMO review (--store firefox only)
  --api-url <url>         Platform URL (or env EXTPORT_API_URL)
  --api-key <key>         API key sk_live_… (or env EXTPORT_API_KEY, or run "extport login")

Safari never takes a file — its binary reaches App Store Connect directly via
"extport safari-build"; this just registers the version with extport:
  extport push --extension <id|slug> --version <x.y.z> --store safari

Missing --extension or --api-key prompts for them interactively in a
terminal; non-interactive runs (CI) fail immediately instead.
`

const STORES = ['chrome', 'firefox', 'edge', 'safari']

/** Falls back to `extport login`'s saved key and extport.config.json's extension/apiUrl. */
export interface PushDefaults {
  extension?: string
  apiKey?: string
  apiUrl?: string
}

export function parsePushArgs(argv: string[], env: Record<string, string | undefined>, defaults: PushDefaults = {}): PushOptions {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) break
    if (arg.startsWith('--')) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`flag ${arg} requires a value`)
      }
      flags[arg.slice(2)] = value
      i++
    } else {
      positional.push(arg)
    }
  }

  const store = flags['store']
  if (store !== undefined && !STORES.includes(store)) {
    throw new Error(`--store must be one of: ${STORES.join(', ')}`)
  }

  const file = positional[0]
  if (!file && store !== 'safari') {
    throw new Error('missing zip file argument (only --store safari can be pushed without one)')
  }
  if (positional.length > 1) throw new Error(`unexpected argument: ${positional[1]}`)

  const extension = flags['extension'] ?? defaults.extension
  if (!extension) throw new Error('--extension is required')
  const version = flags['version']
  if (!version || !/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Error('--version is required and must be 1-4 dot-separated integers')
  }

  const sourceZip = flags['source-zip']
  if (sourceZip !== undefined && store !== 'firefox') {
    throw new Error('--source-zip is only valid with --store firefox')
  }

  const apiKey = flags['api-key'] ?? env.EXTPORT_API_KEY ?? defaults.apiKey
  if (!apiKey) throw new Error('missing API key: run `extport login`, or set EXTPORT_API_KEY / pass --api-key')
  const apiUrl = (flags['api-url'] ?? env.EXTPORT_API_URL ?? defaults.apiUrl ?? 'https://dash.extport.dev').replace(/\/+$/, '')

  return { file, extension, version, store, sourceZip, apiUrl, apiKey }
}

export function buildPushUrl(options: PushOptions): string {
  const url = new URL('/api/v1/artifacts', options.apiUrl)
  url.searchParams.set('extension', options.extension)
  url.searchParams.set('version', options.version)
  if (options.store) url.searchParams.set('store', options.store)
  return url.toString()
}
