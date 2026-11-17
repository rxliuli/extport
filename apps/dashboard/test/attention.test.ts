import { describe, expect, it } from 'vitest'
import type { MatrixExtension, MatrixTarget, Store, TargetLifecycle } from '../src/api'
import { classifyFleet } from '../src/attention'

const NOW = new Date('2026-11-17T12:00:00Z').getTime()
const STALE: Record<Store, number> = { chrome: 3, firefox: 3, edge: 10, safari: 3 }

function lifecycle(partial: Partial<TargetLifecycle>): TargetLifecycle {
  return {
    platform: null,
    status: 'synced',
    liveVersion: '1.0.0',
    inReviewVersion: null,
    queuedVersion: null,
    rejectedVersion: null,
    statusDetail: null,
    submittedAt: null,
    ...partial,
  }
}

function target(store: Store, lifecycles: TargetLifecycle[], extra: Partial<MatrixTarget> = {}): MatrixTarget {
  return {
    targetId: `t_${store}`,
    store,
    enabled: true,
    credentialLabel: store,
    credentialStatus: 'active',
    lifecycles,
    lastReconciledAt: null,
    ...extra,
  }
}

function ext(name: string, targets: MatrixTarget[]): MatrixExtension {
  return { id: `ext_${name}`, name, targets }
}

describe('classifyFleet', () => {
  it('treats a fully synced extension as ok', () => {
    const { actions, inFlight, health } = classifyFleet([ext('a', [target('chrome', [lifecycle({})])])], STALE, NOW)
    expect(actions).toEqual([])
    expect(inFlight).toEqual([])
    expect(health.get('ext_a')).toBe('ok')
  })

  it('flags a rejection as needing action, mentioning what is still live', () => {
    const { actions, health } = classifyFleet(
      [
        ext('imp-write', [
          target('chrome', [lifecycle({ status: 'rejected', liveVersion: '0.0.12', rejectedVersion: '0.0.13' })]),
        ]),
      ],
      STALE,
      NOW,
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ kind: 'rejected', store: 'chrome', label: 'Rejected' })
    expect(actions[0].message).toContain('0.0.13 was rejected. 0.0.12 is still live.')
    expect(health.get('ext_imp-write')).toBe('action')
  })

  it('keeps an Edge review under its threshold in flight, with the queued version', () => {
    const { actions, inFlight, health } = classifyFleet(
      [
        ext('twitter-exporter', [
          target('edge', [
            lifecycle({
              status: 'blocked',
              liveVersion: '0.8.65',
              inReviewVersion: '0.8.66',
              queuedVersion: '0.8.68',
              submittedAt: '2026-11-10T17:42:08Z',
            }),
          ]),
        ]),
      ],
      STALE,
      NOW,
    )
    expect(actions).toEqual([])
    expect(inFlight[0].message).toBe('0.8.66 in review for 6 days · 0.8.68 queued')
    expect(health.get('ext_twitter-exporter')).toBe('in_flight')
  })

  it('escalates a review past the store threshold to needs action', () => {
    const { actions } = classifyFleet(
      [
        ext('a', [
          target('chrome', [
            lifecycle({ status: 'in_review', inReviewVersion: '1.1.0', submittedAt: '2026-11-12T00:00:00Z' }),
          ]),
        ]),
      ],
      STALE,
      NOW,
    )
    expect(actions[0]).toMatchObject({ kind: 'stale_review', label: 'In review for 5 days' })
    expect(actions[0].message).toContain('longer than your 3-day threshold')
  })

  it('flags an extension with no store targets', () => {
    const { actions } = classifyFleet([ext('chatgpt', [])], STALE, NOW)
    expect(actions[0]).toMatchObject({ kind: 'not_set_up', store: null })
  })

  it('ignores targets the tenant disabled', () => {
    const { actions, health } = classifyFleet(
      [ext('a', [target('chrome', [lifecycle({ status: 'error', statusDetail: 'boom' })], { enabled: false })])],
      STALE,
      NOW,
    )
    expect(actions).toEqual([])
    expect(health.get('ext_a')).toBe('ok')
  })

  it('flags an invalid credential once per target, and orders errors before rejections', () => {
    const { actions } = classifyFleet(
      [
        ext('a', [target('chrome', [lifecycle({ status: 'rejected', rejectedVersion: '2.0.0' })])]),
        ext('b', [target('firefox', [lifecycle({ status: 'error', statusDetail: 'version creation failed (429)' })])]),
        ext('c', [target('edge', [lifecycle({})], { credentialStatus: 'invalid' })]),
      ],
      STALE,
      NOW,
    )
    expect(actions.map((a) => a.kind)).toEqual(['error', 'rejected', 'credential'])
  })
})
