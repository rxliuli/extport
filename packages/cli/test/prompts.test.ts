import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fillMissingPushDefaults, fillMissingSafariBuildDefaults, promptText, PromptCancelled } from '../src/prompts.js'

const CANCEL_SYMBOL = Symbol('clack-cancel')

const textMock = vi.fn()
const passwordMock = vi.fn()

// vi.mock is hoisted above these imports by vitest's transform, so the
// plain top-level import of prompts.ts above already resolves against this
// mocked @clack/prompts — no real terminal I/O in this test file.
vi.mock('@clack/prompts', () => ({
  text: (...args: unknown[]) => textMock(...args),
  password: (...args: unknown[]) => passwordMock(...args),
  isCancel: (v: unknown) => v === CANCEL_SYMBOL,
}))

describe('promptText', () => {
  beforeEach(() => {
    textMock.mockReset()
    passwordMock.mockReset()
  })

  it('returns the answer for a plain text prompt', async () => {
    textMock.mockResolvedValue('scrub')
    expect(await promptText('Extension:')).toBe('scrub')
    expect(passwordMock).not.toHaveBeenCalled()
  })

  it('uses the masked password prompt when mask is requested', async () => {
    passwordMock.mockResolvedValue('sk_live_x')
    expect(await promptText('API key:', { mask: true })).toBe('sk_live_x')
    expect(textMock).not.toHaveBeenCalled()
  })

  it('throws PromptCancelled when the user cancels (Ctrl+C)', async () => {
    textMock.mockResolvedValue(CANCEL_SYMBOL)
    await expect(promptText('Extension:')).rejects.toThrow(PromptCancelled)
  })
})

describe('fillMissingPushDefaults', () => {
  beforeEach(() => {
    textMock.mockReset()
    passwordMock.mockReset()
  })

  it('prompts for extension and api key when neither flags, env, nor defaults have them', async () => {
    textMock.mockResolvedValue('scrub')
    passwordMock.mockResolvedValue('sk_live_prompted')

    const filled = await fillMissingPushDefaults([], {}, {})

    expect(filled).toEqual({ extension: 'scrub', apiKey: 'sk_live_prompted' })
    expect(textMock).toHaveBeenCalledTimes(1)
    expect(passwordMock).toHaveBeenCalledTimes(1)
  })

  it('does not prompt for a field already present in argv, env, or defaults', async () => {
    const filled = await fillMissingPushDefaults(['--extension', 'scrub'], { EXTPORT_API_KEY: 'sk_live_env' }, {})
    expect(filled).toEqual({})
    expect(textMock).not.toHaveBeenCalled()
    expect(passwordMock).not.toHaveBeenCalled()
  })

  it('defaults already present (e.g. from extport.config.json / login) short-circuit the prompt too', async () => {
    const filled = await fillMissingPushDefaults([], {}, { extension: 'scrub', apiKey: 'sk_live_saved' })
    expect(filled).toEqual({ extension: 'scrub', apiKey: 'sk_live_saved' })
    expect(textMock).not.toHaveBeenCalled()
    expect(passwordMock).not.toHaveBeenCalled()
  })
})

describe('fillMissingSafariBuildDefaults', () => {
  beforeEach(() => {
    textMock.mockReset()
  })

  it('prompts for each of the four required fields in order, skipping ones already known', async () => {
    textMock.mockResolvedValueOnce('./ios').mockResolvedValueOnce('TEAM1')

    const filled = await fillMissingSafariBuildDefaults([], { ASC_ISSUER_ID: 'iss-env', ASC_KEY_ID: 'key-env' }, {})

    expect(filled).toEqual({ projectPath: './ios', teamId: 'TEAM1' })
    expect(textMock).toHaveBeenCalledTimes(2)
  })

  it('does not prompt for anything already resolvable from argv/env/defaults', async () => {
    const filled = await fillMissingSafariBuildDefaults(
      ['--project-path', './ios', '--team-id', 'TEAM1'],
      { ASC_ISSUER_ID: 'iss-env', ASC_KEY_ID: 'key-env' },
      {},
    )
    expect(filled).toEqual({})
    expect(textMock).not.toHaveBeenCalled()
  })
})
