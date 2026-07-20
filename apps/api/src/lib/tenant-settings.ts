import type { TenantSettings } from '@extport/shared'

export function parseTenantSettings(json: string): TenantSettings {
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? (parsed as TenantSettings) : {}
  } catch {
    return {}
  }
}
