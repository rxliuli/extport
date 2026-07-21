// @ts-check

/**
 * @typedef {{
 *   file: string
 *   extension: string
 *   version: string
 *   store?: string
 *   apiUrl: string
 *   apiKey: string
 * }} PushOptions
 */

export const USAGE = `extport — publish browser extension artifacts

Usage:
  extport push <file.zip> --extension <id|slug> --version <x.y.z> [options]

Options:
  --extension <id|slug>   Target extension (required)
  --version <x.y.z>       Artifact version, 1-4 numeric parts (required)
  --store <name>          chrome | firefox | edge | safari (omit for a universal zip)
  --api-url <url>         Platform URL (or env EXTPORT_API_URL)
  --api-key <key>         API key sk_live_… (or env EXTPORT_API_KEY)
`

const STORES = ['chrome', 'firefox', 'edge', 'safari']

/**
 * @param {string[]} argv - args after the "push" command
 * @param {Record<string, string | undefined>} env
 * @returns {PushOptions}
 */
export function parsePushArgs(argv, env) {
  /** @type {Record<string, string>} */
  const flags = {}
  /** @type {string[]} */
  const positional = []
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

  const file = positional[0]
  if (!file) throw new Error('missing zip file argument')
  if (positional.length > 1) throw new Error(`unexpected argument: ${positional[1]}`)

  const extension = flags['extension']
  if (!extension) throw new Error('--extension is required')
  const version = flags['version']
  if (!version || !/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Error('--version is required and must be 1-4 dot-separated integers')
  }
  const store = flags['store']
  if (store !== undefined && !STORES.includes(store)) {
    throw new Error(`--store must be one of: ${STORES.join(', ')}`)
  }

  const apiKey = flags['api-key'] ?? env.EXTPORT_API_KEY
  if (!apiKey) throw new Error('missing API key: set EXTPORT_API_KEY or pass --api-key')
  const apiUrl = (flags['api-url'] ?? env.EXTPORT_API_URL ?? 'https://dash.extport.dev').replace(/\/+$/, '')

  return { file, extension, version, store, apiUrl, apiKey }
}

/**
 * @param {PushOptions} options
 * @returns {string}
 */
export function buildPushUrl(options) {
  const url = new URL('/api/v1/artifacts', options.apiUrl)
  url.searchParams.set('extension', options.extension)
  url.searchParams.set('version', options.version)
  if (options.store) url.searchParams.set('store', options.store)
  return url.toString()
}
