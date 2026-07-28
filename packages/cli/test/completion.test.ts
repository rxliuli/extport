import { spawn, type ChildProcess } from 'node:child_process'
import type { CommandDef } from 'citty'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectShell,
  extractCompletionSchema,
  generateBashCompletion,
  generateFishCompletion,
  generateZshCompletion,
  parseShellFromComm,
  type CompletionSchema,
} from '../src/completion'

describe('parseShellFromComm', () => {
  it('recognizes bash/zsh/fish by plain name', () => {
    expect(parseShellFromComm('bash')).toBe('bash')
    expect(parseShellFromComm('zsh')).toBe('zsh')
    expect(parseShellFromComm('fish')).toBe('fish')
  })

  it('strips a full path down to the binary name', () => {
    expect(parseShellFromComm('/bin/zsh')).toBe('zsh')
    expect(parseShellFromComm('/usr/local/bin/fish')).toBe('fish')
  })

  it('strips the "-" login-shell prefix', () => {
    expect(parseShellFromComm('-zsh')).toBe('zsh')
  })

  it('returns undefined for anything else', () => {
    expect(parseShellFromComm('node')).toBeUndefined()
    expect(parseShellFromComm('sh')).toBeUndefined()
    expect(parseShellFromComm('')).toBeUndefined()
  })
})

describe('detectShell', () => {
  let spawned: ChildProcess | undefined
  afterEach(() => {
    spawned?.kill()
    spawned = undefined
  })

  it('identifies a real running bash process by pid — not just the pure-parsing path', async () => {
    // No -c command: bash -c '<simple command>' execs directly into that
    // command (replacing itself, same pid) rather than staying resident as
    // bash — confirmed the hard way, this test failed with that form
    // because ps then reported the child command's name, not "bash". With
    // no command and stdin left open, bash just waits and stays itself.
    spawned = spawn('bash', [], { stdio: ['pipe', 'ignore', 'ignore'] })
    await new Promise((resolve) => setTimeout(resolve, 200)) // let it actually start
    expect(detectShell({}, spawned.pid)).toBe('bash')
  })

  it('falls back to $SHELL when the pid has no real process (ps fails)', () => {
    const bogusPid = 999_999_999
    expect(detectShell({ SHELL: '/usr/local/bin/fish' }, bogusPid)).toBe('fish')
    expect(detectShell({ SHELL: '/bin/bash' }, bogusPid)).toBe('bash')
  })

  it('returns undefined when nothing usable is present', () => {
    expect(detectShell({}, 999_999_999)).toBeUndefined()
    expect(detectShell({ SHELL: '/bin/sh' }, 999_999_999)).toBeUndefined()
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
