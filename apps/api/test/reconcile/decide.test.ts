import { describe, expect, it } from 'vitest'
import { decide, mergeState, type PriorState } from '../../src/reconcile/decide'

describe('mergeState', () => {
  const prior: PriorState = { liveVersion: '1.0.0', inReviewVersion: '1.1.0' }

  it('overwrites with authoritative values the store actually returned', () => {
    expect(mergeState(prior, { liveVersion: '1.2.0', inReviewVersion: null })).toEqual({
      liveVersion: '1.2.0',
      inReviewVersion: null,
    })
  })

  it('treats an explicit null as "confirmed empty", not "unknown"', () => {
    expect(mergeState(prior, { liveVersion: null, inReviewVersion: null })).toEqual({
      liveVersion: null,
      inReviewVersion: null,
    })
  })

  it('preserves prior values for fields the store omits entirely (Edge)', () => {
    expect(mergeState(prior, {})).toEqual(prior)
  })

  it('merges field-by-field — one field can be authoritative while the other is preserved', () => {
    expect(mergeState(prior, { liveVersion: '1.2.0' })).toEqual({ liveVersion: '1.2.0', inReviewVersion: '1.1.0' })
  })
})

describe('decide', () => {
  const base = { merged: { liveVersion: null, inReviewVersion: null }, autoWithdraw: true, canWithdraw: true }

  it('does nothing when no artifact has ever been uploaded', () => {
    expect(decide({ ...base, desiredVersion: null })).toEqual({ action: 'noop', status: 'synced' })
  })

  it('does nothing once the desired version is already live', () => {
    expect(
      decide({ ...base, desiredVersion: '1.0.0', merged: { liveVersion: '1.0.0', inReviewVersion: null } }),
    ).toEqual({ action: 'noop', status: 'synced' })
  })

  it('compares versions numerically, not lexically (1.10.0 is newer than 1.9.0)', () => {
    expect(
      decide({ ...base, desiredVersion: '1.9.0', merged: { liveVersion: '1.10.0', inReviewVersion: null } }),
    ).toEqual({ action: 'noop', status: 'synced' })
  })

  it('submits immediately when nothing is in review', () => {
    expect(
      decide({ ...base, desiredVersion: '1.1.0', merged: { liveVersion: '1.0.0', inReviewVersion: null } }),
    ).toEqual({ action: 'submit', version: '1.1.0' })
  })

  it('submits the first-ever version when nothing has been published before', () => {
    expect(decide({ ...base, desiredVersion: '1.0.0' })).toEqual({ action: 'submit', version: '1.0.0' })
  })

  it('waits when the exact desired version is already the one in review', () => {
    expect(
      decide({
        ...base,
        desiredVersion: '1.1.0',
        merged: { liveVersion: '1.0.0', inReviewVersion: '1.1.0' },
      }),
    ).toEqual({ action: 'noop', status: 'in_review' })
  })

  it('reports rejected (not in_review) when the exact desired version was turned down', () => {
    expect(
      decide({
        ...base,
        desiredVersion: '1.1.0',
        merged: { liveVersion: '1.0.0', inReviewVersion: '1.1.0' },
        reviewStatus: 'rejected',
      }),
    ).toEqual({ action: 'noop', status: 'rejected' })
  })

  it('submits straight away when an older in-review version was just rejected — no withdrawal needed', () => {
    expect(
      decide({
        ...base,
        autoWithdraw: false,
        canWithdraw: false,
        desiredVersion: '1.2.0',
        merged: { liveVersion: '1.0.0', inReviewVersion: '1.1.0' },
        reviewStatus: 'rejected',
      }),
    ).toEqual({ action: 'submit', version: '1.2.0' })
  })

  it('withdraws an older pending review before submitting the newer desired version, when allowed', () => {
    expect(
      decide({
        ...base,
        desiredVersion: '1.2.0',
        merged: { liveVersion: '1.0.0', inReviewVersion: '1.1.0' },
      }),
    ).toEqual({ action: 'withdraw_then_submit', version: '1.2.0' })
  })

  it('blocks (waits for the review to resolve) when auto_withdraw is off', () => {
    expect(
      decide({
        ...base,
        autoWithdraw: false,
        desiredVersion: '1.2.0',
        merged: { liveVersion: '1.0.0', inReviewVersion: '1.1.0' },
      }),
    ).toEqual({ action: 'blocked' })
  })

  it('blocks when the store cannot withdraw at all, even if auto_withdraw is on (Edge)', () => {
    expect(
      decide({
        ...base,
        canWithdraw: false,
        desiredVersion: '1.2.0',
        merged: { liveVersion: '1.0.0', inReviewVersion: '1.1.0' },
      }),
    ).toEqual({ action: 'blocked' })
  })
})

describe('mergeState + decide composed — Edge\'s unobservable getState()', () => {
  it('stays in_review across ticks purely from what we recorded after our own submit', () => {
    const prior: PriorState = { liveVersion: null, inReviewVersion: '1.0.0' }
    const merged = mergeState(prior, {}) // Edge always returns {}
    expect(decide({ desiredVersion: '1.0.0', merged, autoWithdraw: true, canWithdraw: false })).toEqual({
      action: 'noop',
      status: 'in_review',
    })
  })

  it('blocks once a newer artifact arrives, since Edge can neither confirm nor cancel the old review', () => {
    const prior: PriorState = { liveVersion: null, inReviewVersion: '1.0.0' }
    const merged = mergeState(prior, {})
    expect(decide({ desiredVersion: '1.1.0', merged, autoWithdraw: true, canWithdraw: false })).toEqual({
      action: 'blocked',
    })
  })
})
