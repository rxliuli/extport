import { describe, expect, it } from 'vitest'
import { formatElapsed, summarizeStoreError } from '../src/status'

describe('summarizeStoreError', () => {
  it('pulls the message out of a Chrome Web Store error body', () => {
    const raw = `publish failed (400): {
  "error": {
    "code": 400,
    "message": "Your submission does not meet the requirements to be published in the store. Check the Developer Dashboard for steps to resolve.",
    "status": "INVALID_ARGUMENT"
  }
}`
    expect(summarizeStoreError(raw)).toBe(
      'The store rejected the request (400): Your submission does not meet the requirements to be published in the store. Check the Developer Dashboard for steps to resolve.',
    )
  })

  it('names rate limiting from an AMO 429', () => {
    const raw =
      'version creation failed (429): {"detail":"Request was throttled. Expected available in 17851 seconds."}'
    expect(summarizeStoreError(raw)).toBe(
      'The store rate-limited extport: Request was throttled. Expected available in 17851 seconds.',
    )
  })

  it('still finds the message in a truncated body', () => {
    expect(summarizeStoreError('publish failed (403): {"error": {"message": "Forbidden", "det')).toBe(
      'The store refused the credential: Forbidden',
    )
  })

  it('pulls the detail out of an App Store Connect JSON:API error body', () => {
    const raw =
      'version creation failed (409): {"errors":[{"status":"409","code":"STATE_ERROR","title":"Conflict","detail":"You cannot create a new version of the App in the current state."}]}'
    expect(summarizeStoreError(raw)).toBe(
      'The store rejected the request (409): You cannot create a new version of the App in the current state.',
    )
  })

  it('leaves messages without a status code alone', () => {
    expect(summarizeStoreError('network unreachable')).toBe('network unreachable')
  })
})

describe('formatElapsed', () => {
  const now = new Date('2026-11-17T12:00:00Z').getTime()
  it.each([
    ['2026-11-17T11:30:00Z', 'less than an hour'],
    ['2026-11-17T11:00:00Z', '1 hour'],
    ['2026-11-16T14:00:00Z', '22 hours'],
    ['2026-11-16T11:00:00Z', '1 day'],
    ['2026-11-10T17:42:08Z', '6 days'],
  ])('%s → %s', (since, expected) => {
    expect(formatElapsed(since, now)).toBe(expected)
  })
})
