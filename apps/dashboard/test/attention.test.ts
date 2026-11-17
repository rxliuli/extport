import { describe, expect, it } from 'vitest'
import type { MatrixExtension, MatrixTarget, Store, TargetLifecycle } from '../src/api'
import { affectedExtensions, classifyFleet, errorSummary, groupActions, isReviewOverdue } from '../src/attention'

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
    error: null,
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
  it('summarizes a store server error in a sentence and keeps the raw response aside', () => {
    const raw = 'version lookup failed (500): { "errors": [{ "code": "UNEXPECTED_ERROR" }] }'
    const { actions } = classifyFleet(
      [
        ext('imp', [
          target('safari', [
            lifecycle({ platform: 'macos', liveVersion: '0.2.9' }),
            lifecycle({
              platform: 'ios',
              status: 'error',
              liveVersion: '0.2.9',
              statusDetail: raw,
              error: { platform: 'ios', status: 500, code: 'UNEXPECTED_ERROR', message: raw },
            }),
          ]),
        ]),
      ],
      STALE,
      NOW,
    )
    expect(actions).toMatchObject([
      {
        platform: 'ios',
        message:
          "App Store Connect returned a server error (500 UNEXPECTED_ERROR). The problem is on the store's side; extport keeps retrying. 0.2.9 is still live.",
        raw,
      },
    ])
  })

  it('shows extport-written errors as is, and falls back to statusDetail without a structured error', () => {
    expect(
      errorSummary('chrome', { platform: null, status: null, code: null, message: 'artifact missing from R2' }),
    ).toEqual({
      summary: 'artifact missing from R2',
      raw: null,
    })
    const { actions } = classifyFleet(
      [ext('a', [target('chrome', [lifecycle({ status: 'error', statusDetail: 'boom' })])])],
      STALE,
      NOW,
    )
    expect(actions[0]).toMatchObject({ message: 'boom 1.0.0 is still live.', raw: null })
  })

  it.each([
    [429, 'is rate limiting requests'],
    [401, 'refused the credential'],
    [404, 'rejected a request'],
  ])('words a %i from the store', (status, phrase) => {
    expect(errorSummary('firefox', { platform: null, status, code: null, message: 'x' }).summary).toContain(phrase)
  })

  it('shows hours for a review under a day old instead of "since today"', () => {
    const { inFlight } = classifyFleet(
      [
        ext('claude', [
          target('edge', [
            lifecycle({ status: 'in_review', inReviewVersion: '0.0.20', submittedAt: '2026-11-16T14:00:00Z' }),
          ]),
        ]),
      ],
      STALE,
      NOW,
    )
    expect(inFlight[0].message).toBe('0.0.20 in review for 22 hours')
  })

  it('lists the longest-waiting review first, queued-only items last', () => {
    const { inFlight } = classifyFleet(
      [
        ext('recent', [
          target('edge', [
            lifecycle({ status: 'in_review', inReviewVersion: '1', submittedAt: '2026-11-16T14:00:00Z' }),
          ]),
        ]),
        ext('queued', [target('firefox', [lifecycle({ status: 'queued', queuedVersion: '2' })])]),
        ext('oldest', [
          target('edge', [
            lifecycle({ status: 'in_review', inReviewVersion: '3', submittedAt: '2026-11-10T17:42:08Z' }),
          ]),
        ]),
      ],
      STALE,
      NOW,
    )
    expect(inFlight.map((i) => i.extensionName)).toEqual(['oldest', 'recent', 'queued'])
  })
})

describe('groupActions', () => {
  const asc500 = (platform: 'macos' | 'ios') =>
    lifecycle({
      platform,
      status: 'error',
      statusDetail: 'raw',
      error: { platform, status: 500, code: 'UNEXPECTED_ERROR', message: `${platform} raw` },
    })

  it('collapses one store-side cause across extensions into a single entry, in order', () => {
    const { actions } = classifyFleet(
      [
        ext('imp', [target('safari', [asc500('macos'), asc500('ios')])]),
        ext('tube', [target('safari', [asc500('macos'), lifecycle({ platform: 'ios' })])]),
        ext('other', [target('chrome', [lifecycle({ status: 'error', statusDetail: 'artifact missing from R2' })])]),
        ext('rej', [target('firefox', [lifecycle({ status: 'rejected', rejectedVersion: '2.0.0' })])]),
      ],
      STALE,
      NOW,
    )
    const entries = groupActions(actions)
    expect(entries.map((e) => (e.type === 'group' ? `group:${e.group.items.length}` : e.item.kind))).toEqual([
      'group:3',
      'error',
      'rejected',
    ])
    const group = entries[0]!.type === 'group' ? entries[0]!.group : null
    expect(group).toMatchObject({
      store: 'safari',
      summary: "App Store Connect returned a server error (500 UNEXPECTED_ERROR). The problem is on the store's side; extport keeps retrying.",
      raw: 'macos raw',
    })
    expect(affectedExtensions(group!)).toEqual([
      { extensionId: 'ext_imp', name: 'imp', platforms: ['macos', 'ios'] },
      { extensionId: 'ext_tube', name: 'tube', platforms: ['macos'] },
    ])
  })

  it('keeps different causes apart, and a cause with one lifecycle as a plain item', () => {
    const { actions } = classifyFleet(
      [
        ext('a', [target('safari', [asc500('macos')])]),
        ext('b', [
          target('safari', [
            lifecycle({ platform: 'macos', status: 'error', error: { platform: 'macos', status: 503, code: null, message: 'x' } }),
          ]),
        ]),
        ext('c', [
          target('chrome', [
            lifecycle({ status: 'error', error: { platform: null, status: 500, code: 'UNEXPECTED_ERROR', message: 'x' } }),
          ]),
        ]),
      ],
      STALE,
      NOW,
    )
    expect(groupActions(actions).map((e) => e.type)).toEqual(['item', 'item', 'item'])
  })
})

describe('isReviewOverdue', () => {
  const at = (iso: string) => ({ inReviewVersion: '1.0.0', submittedAt: iso })
  it('flips at the per-store threshold, not before', () => {
    // NOW is 2026-11-17T12:00Z; chrome's threshold is 3 days, edge's 10.
    expect(isReviewOverdue('chrome', at('2026-11-15T12:00:00Z'), STALE, NOW)).toBe(false)
    expect(isReviewOverdue('chrome', at('2026-11-14T12:00:00Z'), STALE, NOW)).toBe(true)
    expect(isReviewOverdue('edge', at('2026-11-14T12:00:00Z'), STALE, NOW)).toBe(false)
  })

  it('never judges a review with no submit time, or no review at all', () => {
    expect(isReviewOverdue('chrome', { inReviewVersion: '1.0.0', submittedAt: null }, STALE, NOW)).toBe(false)
    expect(isReviewOverdue('chrome', { inReviewVersion: null, submittedAt: '2026-01-01T00:00:00Z' }, STALE, NOW)).toBe(false)
  })
})

describe('store timeouts', () => {
  it('read as a store-side problem and group like any other store failure', () => {
    const timeout = (platform: 'macos' | 'ios') =>
      lifecycle({
        platform,
        status: 'error',
        error: { platform, status: null, code: 'TIMEOUT', message: 'safari request timed out after 60s: GET /v1/apps/1' },
      })
    expect(errorSummary('safari', timeout('macos').error).summary).toBe(
      "App Store Connect didn't respond within 60s. The problem is on the store's side; extport keeps retrying.",
    )
    const { actions } = classifyFleet(
      [ext('a', [target('safari', [timeout('macos')])]), ext('b', [target('safari', [timeout('macos')])])],
      STALE,
      NOW,
    )
    expect(groupActions(actions).map((e) => (e.type === 'group' ? e.group.items.length : 0))).toEqual([2])
  })
})
