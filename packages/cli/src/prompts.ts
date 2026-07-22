import { isCancel, password, text } from '@clack/prompts'
import type { PushDefaults } from './args'
import type { SafariBuildDefaults } from './safari-build-args'

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
 * Only prompts for what's still missing after flags/env/defaults — a fully
 * non-interactive invocation (CI, or one that already passed everything)
 * never touches this. Only called when stdin is a TTY.
 */
export async function fillMissingPushDefaults(argv: string[], env: Record<string, string | undefined>, defaults: PushDefaults): Promise<PushDefaults> {
  const filled = { ...defaults }
  if (!hasFlag(argv, 'extension') && !filled.extension) {
    filled.extension = await ask('Extension (id or slug):', { validate: required('Extension') })
  }
  if (!hasFlag(argv, 'api-key') && !env.EXTPORT_API_KEY && !filled.apiKey) {
    filled.apiKey = await ask("API key (run 'extport login' to avoid this next time):", { mask: true, validate: required('API key') })
  }
  return filled
}

/**
 * Same idea for safari-build's four required fields — filled one at a time,
 * in the order the tenant is most likely to have them on hand.
 */
export async function fillMissingSafariBuildDefaults(
  argv: string[],
  env: Record<string, string | undefined>,
  defaults: SafariBuildDefaults,
): Promise<SafariBuildDefaults> {
  const filled = { ...defaults }
  if (!hasFlag(argv, 'project-path') && !filled.projectPath) {
    filled.projectPath = await ask('Path to the Xcode project directory:', { validate: required('Project path') })
  }
  if (!hasFlag(argv, 'team-id') && !filled.teamId) {
    filled.teamId = await ask('Apple Developer Team ID:', { validate: required('Team ID') })
  }
  if (!hasFlag(argv, 'issuer-id') && !env.ASC_ISSUER_ID && !filled.issuerId) {
    filled.issuerId = await ask('App Store Connect issuer id:', { validate: required('Issuer id') })
  }
  if (!hasFlag(argv, 'key-id') && !env.ASC_KEY_ID && !filled.keyId) {
    filled.keyId = await ask('App Store Connect key id:', { validate: required('Key id') })
  }
  return filled
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`)
}
