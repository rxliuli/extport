import { describe, expect, it } from 'vitest'
import { decide } from '../../src/reconcile/decide'

describe('decide', () => {
  it('does nothing when nothing is queued', () => {
    expect(decide({ hasQueued: false, stillInReview: false, storeBusy: false })).toEqual({ action: 'noop' })
  })

  it('does nothing when nothing is queued, even if something is still in review', () => {
    expect(decide({ hasQueued: false, stillInReview: true, storeBusy: true })).toEqual({ action: 'noop' })
  })

  it('submits the queued row when nothing is in the way', () => {
    expect(decide({ hasQueued: true, stillInReview: false, storeBusy: false })).toEqual({ action: 'submit' })
  })

  it('waits — never cancels an in-review row to make room for the queued one', () => {
    expect(decide({ hasQueued: true, stillInReview: true, storeBusy: false })).toEqual({ action: 'wait' })
  })

  // A maintainer editing the listing by hand puts the item into review under a
  // version we already have live, so no row of ours describes it. Uploading
  // anyway just collects the store's rejection every tick.
  it('waits when the store reports a review we have no row for', () => {
    expect(decide({ hasQueued: true, stillInReview: false, storeBusy: true })).toEqual({ action: 'wait' })
  })

  it('submits once the store stops reporting a review', () => {
    expect(decide({ hasQueued: true, stillInReview: false, storeBusy: false })).toEqual({ action: 'submit' })
  })
})
