import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Exec } from './exec'

export interface IosDevice {
  identifier: string
  name: string
  udid?: string
  model?: string
  osVersion?: string
  connected: boolean
}

interface RawOsVersion {
  stringValue?: string
}

interface RawDevice {
  identifier?: string
  visibilityClass?: string
  properties?: {
    hardware?: { platform?: string; deviceType?: string; udid?: string; marketingName?: string; reality?: string }
    connection?: { tunnelState?: string; pairingState?: string; transportType?: string }
    software?: { osVersionNumber?: string | RawOsVersion }
    state?: { name?: string }
    device?: { name?: string }
  }
  hardwareProperties?: {
    platform?: string
    deviceType?: string
    udid?: string
    marketingName?: string
    reality?: string
  }
  connectionProperties?: { tunnelState?: string; pairingState?: string; transportType?: string }
  deviceProperties?: { name?: string; osVersionNumber?: string | RawOsVersion }
}

function formatOsVersion(value: string | RawOsVersion | undefined): string | undefined {
  if (typeof value === 'string') return value || undefined
  if (value && typeof value.stringValue === 'string') return value.stringValue || undefined
  return undefined
}

/**
 * Parses `xcrun devicectl list devices --json-output` while tolerating both
 * Xcode 27+'s `properties.*` schema and earlier `*Properties` fields.
 * Excludes simulators and non-iOS/iPadOS devices.
 */
export function parseDevicectlDevices(jsonText: string): IosDevice[] {
  const parsed = JSON.parse(jsonText) as { result?: { devices?: RawDevice[] } }
  const rawDevices = parsed.result?.devices ?? []
  const devices: IosDevice[] = []

  for (const d of rawDevices) {
    if (!d.identifier) continue
    if (d.visibilityClass === 'simulators') continue

    const hw = d.properties?.hardware ?? d.hardwareProperties
    const conn = d.properties?.connection ?? d.connectionProperties
    const sw = d.properties?.software
    const dev = d.deviceProperties

    if (hw?.reality && hw.reality !== 'physical') continue
    const platform = hw?.platform?.toLowerCase()
    if (platform && platform !== 'ios' && platform !== 'ipados') continue
    if (conn?.transportType === 'sameMachine') continue

    const name =
      d.properties?.device?.name ?? d.properties?.state?.name ?? dev?.name ?? hw?.marketingName ?? d.identifier
    const connected =
      conn?.tunnelState === 'connected' || conn?.transportType === 'wired' || conn?.pairingState === 'paired'

    devices.push({
      identifier: d.identifier,
      name,
      udid: hw?.udid,
      model: hw?.marketingName ?? hw?.deviceType,
      osVersion: formatOsVersion(sw?.osVersionNumber) ?? formatOsVersion(dev?.osVersionNumber),
      connected,
    })
  }

  return devices.sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name))
}

export async function discoverIosDevices(exec: Exec): Promise<IosDevice[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'extport-devicectl-'))
  const jsonPath = path.join(dir, 'devices.json')
  try {
    const res = await exec('xcrun', ['devicectl', 'list', 'devices', '--json-output', jsonPath])
    if (res.status !== 0) {
      throw new Error(`xcrun devicectl list devices failed${res.stderr.trim() ? `: ${res.stderr.trim()}` : ''}`)
    }
    const text = await readFile(jsonPath, 'utf-8')
    return parseDevicectlDevices(text)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface SelectIosDeviceOptions {
  devices: IosDevice[]
  query?: string
  isTTY: boolean
  promptSelect?: (devices: IosDevice[]) => Promise<IosDevice>
}

export async function selectIosDevice(opts: SelectIosDeviceOptions): Promise<IosDevice> {
  if (opts.devices.length === 0) {
    throw new Error(
      'no physical iOS device found — connect and unlock your iPhone/iPad via USB (or pair it in Xcode), or pass --output <path> to export an .ipa instead',
    )
  }

  if (opts.query) {
    const q = opts.query.trim().toLowerCase()
    const matched = opts.devices.filter(
      (d) => d.identifier.toLowerCase() === q || d.udid?.toLowerCase() === q || d.name.toLowerCase().includes(q),
    )
    if (matched.length === 1) return matched[0]!
    if (matched.length > 1) {
      throw new Error(
        `--device "${opts.query}" matched multiple devices:\n${matched.map((d) => `  - ${d.name} (${d.udid ?? d.identifier})`).join('\n')}`,
      )
    }
    throw new Error(
      `--device "${opts.query}" did not match any device:\n${opts.devices.map((d) => `  - ${d.name} (${d.udid ?? d.identifier})`).join('\n')}`,
    )
  }

  if (opts.devices.length === 1) return opts.devices[0]!

  if (!opts.isTTY || !opts.promptSelect) {
    throw new Error(
      `multiple iOS devices found — pass --device <name|udid>:\n${opts.devices.map((d) => `  - ${d.name} (${d.udid ?? d.identifier})`).join('\n')}`,
    )
  }

  return opts.promptSelect(opts.devices)
}
