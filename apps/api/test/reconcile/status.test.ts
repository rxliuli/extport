import type { TargetError } from '@extport/shared'
import { describe, expect, it } from 'vitest'
import type { DeploymentVersion } from '../../src/db'
import { deriveTargetLifecycles } from '../../src/reconcile/status'

function row(platform: DeploymentVersion['platform'], version: string): DeploymentVersion {
  return {
    id: `dv_${platform}_${version}`,
    tenantId: 't',
    extensionId: 'e',
    store: 'safari',
    platform,
    version,
    artifactId: null,
    status: 'online',
    statusDetail: null,
    submittedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  } as DeploymentVersion
}

const asc500 = (platform: string | null): TargetError => ({
  platform,
  status: 500,
  code: 'UNEXPECTED_ERROR',
  message: 'version lookup failed (500): {...}',
})

describe('deriveTargetLifecycles — errors', () => {
  it('shows each Safari platform only its own failure', () => {
    const lifecycles = deriveTargetLifecycles([row('macos', '1.0.0'), row('ios', '1.0.0')], {
      lastErrorDetail: 'ios: version lookup failed (500): {...}',
      lastErrors: [asc500('ios')],
    })
    expect(lifecycles.map((l) => [l.platform, l.status, l.error?.status ?? null])).toEqual([
      ['macos', 'synced', null],
      ['ios', 'error', 500],
    ])
    expect(lifecycles[1]!.statusDetail).toBe('version lookup failed (500): {...}')
  })

  it('applies a platform-less failure to every lifecycle', () => {
    const lifecycles = deriveTargetLifecycles([row('macos', '1.0.0'), row('ios', '1.0.0')], {
      lastErrorDetail: 'store credential "x" failed verification',
      lastErrors: [{ platform: null, status: null, code: null, message: 'store credential "x" failed verification' }],
    })
    expect(lifecycles.every((l) => l.status === 'error' && l.error?.platform === null)).toBe(true)
  })

  it('gives a platform that failed before it ever had a row its own lifecycle', () => {
    const lifecycles = deriveTargetLifecycles([row('macos', '1.0.0')], {
      lastErrorDetail: 'ios: …',
      lastErrors: [asc500('ios')],
    })
    expect(lifecycles.map((l) => [l.platform, l.status])).toEqual([
      ['macos', 'synced'],
      ['ios', 'error'],
    ])
  })

  it('replaces the no-rows placeholder lifecycle once a platform has failed', () => {
    const lifecycles = deriveTargetLifecycles([], { lastErrorDetail: 'macos: …', lastErrors: [asc500('macos')] })
    expect(lifecycles.map((l) => l.platform)).toEqual(['macos'])
  })

  it('falls back to the text on every lifecycle for rows that predate lastErrors', () => {
    const lifecycles = deriveTargetLifecycles([row('macos', '1.0.0'), row('ios', '1.0.0')], {
      lastErrorDetail: 'macos: boom',
      lastErrors: null,
    })
    expect(lifecycles.map((l) => [l.status, l.statusDetail, l.error])).toEqual([
      ['error', 'macos: boom', { platform: null, status: null, code: null, message: 'macos: boom' }],
      ['error', 'macos: boom', { platform: null, status: null, code: null, message: 'macos: boom' }],
    ])
  })

  it('has no error when the target is healthy, even with stale lastErrors', () => {
    const [l] = deriveTargetLifecycles([row(null, '1.0.0')], { lastErrorDetail: null, lastErrors: [asc500(null)] })
    expect(l).toMatchObject({ status: 'synced', error: null })
  })
})
