import Bowser from 'bowser'

export interface DeviceAgentInfo {
  browser: string | null
  os: string | null
  label: string | null
}

function majorVersion(version: string | undefined): string | null {
  if (!version) return null
  const major = version.split('.')[0]?.trim()
  return major && /^\d+$/.test(major) ? major : null
}

/**
 * Parse a User-Agent string with bowser into a compact human-readable label
 * such as "Chrome 131 · macOS" or "Microsoft Edge 131 · Windows".
 */
export function parseDeviceAgent(ua: string | null | undefined): DeviceAgentInfo {
  const trimmed = ua?.trim()
  if (!trimmed) return { browser: null, os: null, label: null }

  const parsed = Bowser.parse(trimmed)
  const browserName = parsed.browser.name?.trim() || null
  const browserMajor = majorVersion(parsed.browser.version)
  const browser = browserName ? (browserMajor ? `${browserName} ${browserMajor}` : browserName) : null
  const os = parsed.os.name?.trim() || null

  const parts = [browser, os].filter((p): p is string => Boolean(p))
  return {
    browser,
    os,
    label: parts.length > 0 ? parts.join(' · ') : null,
  }
}
