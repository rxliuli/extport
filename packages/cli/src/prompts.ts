import { isCancel, password, text } from '@clack/prompts'
import type { PushDefaults, RawPushArgs } from './args'
import type { RawSafariBuildArgs, SafariBuildDefaults } from './safari-build-args'

export class PromptCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

export async function promptText(
  message: string,
  opts: { mask?: boolean; placeholder?: string; validate?: (v: string | undefined) => string | undefined } = {},
): Promise<string> {
  const result = opts.mask
    ? await password({ message, validate: opts.validate })
    : await text({ message, placeholder: opts.placeholder, validate: opts.validate })
  if (isCancel(result)) throw new PromptCancelled()
  return result
}

const ask = promptText
const required = (label: string) => (v: string | undefined) => (v?.trim() ? undefined : `${label} is required`)
export const requiredField = required

/**
 * Only prompts for what's still missing after citty's own flag parsing plus
 * env/defaults — a fully non-interactive invocation (CI, or one that
 * already passed everything) never touches this. Only called when stdin is
 * a TTY.
 */
export async function fillMissingPushDefaults(raw: RawPushArgs, env: Record<string, string | undefined>, defaults: PushDefaults): Promise<PushDefaults> {
  const filled = { ...defaults }
  if (!raw.extension && !filled.extension) {
    filled.extension = await ask('Extension id (ext_…):', { validate: required('Extension') })
  }
  if (!raw.apiKey && !env.EXTPORT_API_KEY && !filled.apiKey) {
    filled.apiKey = await ask("API key (run 'extport login' to avoid this next time):", { mask: true, validate: required('API key') })
  }
  return filled
}

/**
 * Same idea for safari-build's four required fields — filled one at a time,
 * in the order the tenant is most likely to have them on hand.
 */
export async function fillMissingSafariBuildDefaults(
  raw: RawSafariBuildArgs,
  env: Record<string, string | undefined>,
  defaults: SafariBuildDefaults,
): Promise<SafariBuildDefaults> {
  const filled = { ...defaults }
  if (!raw.projectPath && !filled.projectPath) {
    filled.projectPath = await ask('Path to the Xcode project directory:', { validate: required('Project path') })
  }
  if (!raw.teamId && !filled.teamId) {
    filled.teamId = await ask('Apple Developer Team ID:', { validate: required('Team ID') })
  }
  if (!raw.issuerId && !env.ASC_ISSUER_ID && !filled.issuerId) {
    filled.issuerId = await ask('App Store Connect issuer id:', { validate: required('Issuer id') })
  }
  if (!raw.keyId && !env.ASC_KEY_ID && !filled.keyId) {
    filled.keyId = await ask('App Store Connect key id:', { validate: required('Key id') })
  }
  return filled
}
