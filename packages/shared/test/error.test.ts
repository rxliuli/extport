import { describe, expect, it } from 'vitest'
import { summarizeStoreError } from '../src/error'

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

  it('pulls the detail out of an App Store Connect JSON:API error body', () => {
    const raw =
      'version creation failed (409): {"errors":[{"status":"409","code":"STATE_ERROR","title":"Conflict","detail":"You cannot create a new version of the App in the current state."}]}'
    expect(summarizeStoreError(raw)).toBe(
      'The store rejected the request (409): You cannot create a new version of the App in the current state.',
    )
  })

  it('still finds the message in a truncated body', () => {
    expect(summarizeStoreError('publish failed (403): {"error": {"message": "Forbidden", "det')).toBe(
      'The store refused the credential: Forbidden',
    )
  })

  it('leaves messages without a status code alone', () => {
    expect(summarizeStoreError('network unreachable')).toBe('network unreachable')
  })
})
