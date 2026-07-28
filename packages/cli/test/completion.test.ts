import type { CommandDef } from 'citty'
import { describe, expect, it } from 'vitest'
import {
  detectShell,
  extractCompletionSchema,
  generateBashCompletion,
  generateFishCompletion,
  generateZshCompletion,
  type CompletionSchema,
} from '../src/completion'

describe('detectShell', () => {
  it('prefers the shell-set version vars over $SHELL', () => {
    expect(detectShell({ ZSH_VERSION: '5.9', SHELL: '/bin/bash' })).toBe('zsh')
    expect(detectShell({ BASH_VERSION: '5.2', SHELL: '/bin/zsh' })).toBe('bash')
    expect(detectShell({ FISH_VERSION: '3.7' })).toBe('fish')
  })

  it('falls back to $SHELL when no version var is set', () => {
    expect(detectShell({ SHELL: '/usr/local/bin/fish' })).toBe('fish')
    expect(detectShell({ SHELL: '/bin/bash' })).toBe('bash')
  })

  it('returns undefined when nothing usable is present', () => {
    expect(detectShell({})).toBeUndefined()
    expect(detectShell({ SHELL: '/bin/sh' })).toBeUndefined()
  })
})

describe('extractCompletionSchema', () => {
  it('pulls subcommand names, flag names, and enum options — skips positionals', () => {
    const cmd: CommandDef = {
      meta: { name: 'extport' },
      subCommands: {
        push: {
          meta: { name: 'push', description: 'Upload an artifact' },
          args: {
            file: { type: 'positional', description: 'zip path' },
            store: { type: 'enum', options: ['chrome', 'firefox'], description: 'target store' },
            'api-key': { type: 'string' },
          },
        },
        logout: { meta: { name: 'logout' } },
      },
    }

    expect(extractCompletionSchema(cmd)).toEqual({
      name: 'extport',
      subcommands: [
        {
          name: 'push',
          description: 'Upload an artifact',
          flags: [
            { name: 'store', options: ['chrome', 'firefox'] },
            { name: 'api-key', options: undefined },
          ],
        },
        { name: 'logout', description: undefined, flags: [] },
      ],
    })
  })

  it('falls back to the object key when a subcommand has no meta.name', () => {
    const cmd: CommandDef = { meta: { name: 'cli' }, subCommands: { whoami: {} } }
    expect(extractCompletionSchema(cmd).subcommands).toEqual([{ name: 'whoami', description: undefined, flags: [] }])
  })
})

const schema: CompletionSchema = {
  name: 'extport',
  subcommands: [
    { name: 'logout', flags: [] },
    { name: 'push', description: 'Upload', flags: [{ name: 'store', options: ['chrome', 'firefox'] }, { name: 'api-key' }] },
  ],
}

describe('generateBashCompletion', () => {
  const script = generateBashCompletion(schema)

  it('registers the completion function for the right command name', () => {
    expect(script).toContain('complete -F _extport_completions extport')
  })

  it('lists every subcommand for top-level completion', () => {
    expect(script).toContain('compgen -W "logout push"')
  })

  it('completes enum flag values keyed by subcommand:flag', () => {
    expect(script).toContain('push:--store) COMPREPLY=( $(compgen -W "chrome firefox" -- "$cur") ); return ;;')
  })

  it('completes flag names per subcommand', () => {
    expect(script).toContain('push) COMPREPLY=( $(compgen -W "--store --api-key" -- "$cur") ) ;;')
  })
})

describe('generateZshCompletion', () => {
  const script = generateZshCompletion(schema)

  it('registers the completion function via compdef', () => {
    expect(script).toContain('compdef _extport extport')
  })

  it('quotes subcommand and flag names for compadd', () => {
    expect(script).toContain("compadd -- 'logout' 'push'")
    expect(script).toContain("push:--store) compadd -- 'chrome' 'firefox'; return ;;")
  })
})

describe('generateFishCompletion', () => {
  const script = generateFishCompletion(schema)

  it('disables file completion and registers each subcommand', () => {
    expect(script).toContain('complete -c extport -f')
    expect(script).toContain("complete -c extport -n '__fish_use_subcommand' -a 'push' -d 'Upload'")
  })

  it('scopes flags to their subcommand and offers enum values', () => {
    expect(script).toContain("complete -c extport -n '__fish_seen_subcommand_from push' -l store -a 'chrome firefox'")
    expect(script).toContain("complete -c extport -n '__fish_seen_subcommand_from push' -l api-key")
  })

  it('escapes single quotes in descriptions', () => {
    const withQuote: CompletionSchema = { name: 'x', subcommands: [{ name: 'a', description: "it's fine", flags: [] }] }
    expect(generateFishCompletion(withQuote)).toContain(`-d 'it'\\''s fine'`)
  })
})
