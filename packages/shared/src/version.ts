/**
 * Extension version format: 1–4 dot-separated integers (Chromium manifest
 * rules; Firefox/Edge/Safari accept the same shape). Not full semver — no
 * prerelease/build suffixes, stores reject them.
 */
export function isValidExtensionVersion(version: string): boolean {
  if (!/^\d+(\.\d+){0,3}$/.test(version)) return false
  return version.split('.').every((part) => {
    if (part.length > 1 && part.startsWith('0')) return false
    return Number(part) <= 65535
  })
}

/** Numeric-aware compare; missing parts count as 0 (1.2 == 1.2.0). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

export function maxVersion(versions: string[]): string | null {
  let max: string | null = null
  for (const v of versions) {
    if (max === null || compareVersions(v, max) > 0) max = v
  }
  return max
}
