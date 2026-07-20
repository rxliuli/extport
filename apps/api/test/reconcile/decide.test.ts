import { describe, expect, it } from 'vitest'
import { decide } from '../../src/reconcile/decide'

describe('decide', () => {
  it('does nothing when nothing is queued', () => {
    expect(decide({ hasQueued: false, stillInReview: false })).toEqual({ action: 'noop' })
  })

  it('does nothing when nothing is queued, even if something is still in review', () => {
    expect(decide({ hasQueued: false, stillInReview: true })).toEqual({ action: 'noop' })
  })

  it('submits the queued row when nothing is in the way', () => {
    expect(decide({ hasQueued: true, stillInReview: false })).toEqual({ action: 'submit' })
  })

  it('waits — never cancels an in-review row to make room for the queued one', () => {
    expect(decide({ hasQueued: true, stillInReview: true })).toEqual({ action: 'wait' })
  })
})
