import { describe, expect, it } from 'vitest'
import { storeApiError, submitFailure } from '../src/util'

describe('storeApiError', () => {
  it('keeps the message shape adapters always used', () => {
    expect(storeApiError('amo unavailable', 503).message).toBe('amo unavailable (503)')
    expect(storeApiError('upload failed', 400, 'bad zip').message).toBe('upload failed (400): bad zip')
  })

  it.each([
    ['ASC / JSON:API', { errors: [{ code: 'UNEXPECTED_ERROR' }] }, 'UNEXPECTED_ERROR'],
    ['Google APIs', { error: { code: 500, status: 'INTERNAL' } }, 'INTERNAL'],
    ['OAuth', { error: 'invalid_grant' }, 'invalid_grant'],
    ['plain code', { code: 'throttled' }, 'throttled'],
    ['no code', { detail: 'Not found.' }, null],
  ])('reads the error code from a %s body', (_name, body, code) => {
    expect(storeApiError('x', 500, JSON.stringify(body)).code).toBe(code)
  })

  it('has no code for a non-JSON body', () => {
    expect(storeApiError('x', 502, '<html>Bad Gateway</html>').code).toBeNull()
  })
})

describe('submitFailure', () => {
  it('is a plain failure carrying the status and code', () => {
    expect(submitFailure('publish failed', 500, JSON.stringify({ error: { status: 'INTERNAL' } }))).toEqual({
      submitted: false,
      detail: 'publish failed (500): {"error":{"status":"INTERNAL"}}',
      status: 500,
      code: 'INTERNAL',
    })
  })
})
