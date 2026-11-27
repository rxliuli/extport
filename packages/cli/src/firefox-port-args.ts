import { isValidGeckoId } from './firefox-port-manifest'

export interface RawFirefoxPortArgs {
  source?: string
  output?: string
  unpacked?: boolean
  geckoId?: string
  minVersion?: string
  run?: boolean
  firefox?: string
  keepUnpacked?: string
  debug?: boolean
}

export interface FirefoxPortOptions {
  source: string
  output?: string
  unpacked: boolean
  geckoId?: string
  minVersion?: string
  run: boolean
  firefox?: string
  keepUnpacked?: string
  debug: boolean
}

const MIN_VERSION_RE = /^\d+(?:\.(?:\d+|\*)){0,3}$/

export function resolveFirefoxPortOptions(raw: RawFirefoxPortArgs): FirefoxPortOptions {
  const source = raw.source?.trim()
  if (!source) {
    throw new Error(
      '<source> is required — pass a Chrome Web Store URL, 32-char extension ID, or local directory / .crx / .zip',
    )
  }

  const output = raw.output?.trim() || undefined
  const unpacked = Boolean(raw.unpacked)
  if (unpacked && output && output.toLowerCase().endsWith('.xpi')) {
    throw new Error('--unpacked cannot be combined with an .xpi --output file path')
  }

  const geckoId = raw.geckoId?.trim() || undefined
  if (geckoId !== undefined && !isValidGeckoId(geckoId)) {
    throw new Error(
      '--gecko-id must be a valid Firefox add-on ID (email-like such as my-ext@port.extport.dev, or a braced UUID {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx})',
    )
  }

  const minVersion = raw.minVersion?.trim() || undefined
  if (minVersion !== undefined && !MIN_VERSION_RE.test(minVersion)) {
    throw new Error('--min-version must be a valid Firefox version string like 128.0 or 140.0')
  }

  const run = Boolean(raw.run)
  const firefox = raw.firefox?.trim() || undefined
  if (firefox && !run) {
    throw new Error('--firefox is only valid with --run')
  }

  return {
    source,
    output,
    unpacked,
    geckoId,
    minVersion,
    run,
    firefox,
    keepUnpacked: raw.keepUnpacked?.trim() || undefined,
    debug: Boolean(raw.debug),
  }
}
