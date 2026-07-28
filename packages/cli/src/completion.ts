import type { ArgDef, ArgsDef, CommandDef, CommandMeta } from 'citty'

export type Shell = 'bash' | 'zsh' | 'fish'

/**
 * `$ZSH_VERSION`/`$BASH_VERSION`/`$FISH_VERSION` are set by the shell
 * binary itself at startup, before any rc file runs — reliable even when
 * this exact line ends up pasted into that rc file and re-run on every new
 * shell. `$SHELL` (the user's *login* shell, not necessarily the one
 * currently running) is a weaker fallback for a one-off interactive check.
 */
export function detectShell(env: Record<string, string | undefined>): Shell | undefined {
  if (env.ZSH_VERSION) return 'zsh'
  if (env.BASH_VERSION) return 'bash'
  if (env.FISH_VERSION) return 'fish'
  const base = env.SHELL?.split('/').pop()
  if (base === 'bash' || base === 'zsh' || base === 'fish') return base
  return undefined
}

export interface CompletionFlag {
  name: string
  options?: string[]
}

export interface CompletionSubcommand {
  name: string
  description?: string
  flags: CompletionFlag[]
}

export interface CompletionSchema {
  name: string
  subcommands: CompletionSubcommand[]
}

/**
 * Walks a citty CommandDef's subCommands, keeping just what shell
 * completion needs (subcommand names, flag names, enum values). Assumes
 * subCommands/args/meta are plain objects, never citty's Resolvable
 * function/promise form — true for every command this CLI defines, so
 * that form is deliberately left unhandled rather than guessed at.
 */
export function extractCompletionSchema(cmd: CommandDef): CompletionSchema {
  const meta = cmd.meta as CommandMeta | undefined
  const subCommandsDef = (cmd.subCommands as Record<string, CommandDef> | undefined) ?? {}

  const subcommands: CompletionSubcommand[] = Object.entries(subCommandsDef).map(([key, sub]) => {
    const subMeta = sub.meta as CommandMeta | undefined
    const argsDef = (sub.args as ArgsDef | undefined) ?? {}
    const flags: CompletionFlag[] = Object.entries(argsDef)
      .filter(([, def]) => (def as ArgDef).type !== 'positional')
      .map(([flagName, def]) => ({
        name: flagName,
        options: (def as ArgDef).type === 'enum' ? (def as ArgDef & { options: string[] }).options : undefined,
      }))
    return { name: subMeta?.name ?? key, description: subMeta?.description, flags }
  })

  return { name: meta?.name ?? 'cli', subcommands }
}

/** Single-quoted-string safe in bash/zsh/fish alike: close, escaped quote, reopen. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

function enumCompletions(schema: CompletionSchema): { subcommand: string; flag: string; options: string[] }[] {
  return schema.subcommands.flatMap((sub) => sub.flags.filter((f) => f.options).map((f) => ({ subcommand: sub.name, flag: f.name, options: f.options! })))
}

export function generateBashCompletion(schema: CompletionSchema): string {
  const fn = `_${schema.name}_completions`
  const subNames = schema.subcommands.map((s) => s.name).join(' ')
  const enumCases = enumCompletions(schema)
    .map((e) => `    ${e.subcommand}:--${e.flag}) COMPREPLY=( $(compgen -W "${e.options.join(' ')}" -- "$cur") ); return ;;`)
    .join('\n')
  const flagCases = schema.subcommands
    .map((s) => `    ${s.name}) COMPREPLY=( $(compgen -W "${s.flags.map((f) => `--${f.name}`).join(' ')}" -- "$cur") ) ;;`)
    .join('\n')

  return `# ${schema.name} bash completion — generated from the CLI's own command definitions.
# Add to your shell config: eval "$(${schema.name} completion bash)"
${fn}() {
  local cur prev sub
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  sub="\${COMP_WORDS[1]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${subNames}" -- "$cur") )
    return
  fi

  case "$sub:$prev" in
${enumCases}
  esac

  case "$sub" in
${flagCases}
  esac
}
complete -F ${fn} ${schema.name}
`
}

export function generateZshCompletion(schema: CompletionSchema): string {
  const fn = `_${schema.name}`
  const subNames = schema.subcommands.map((s) => shQuote(s.name)).join(' ')
  const enumCases = enumCompletions(schema)
    .map((e) => `    ${e.subcommand}:--${e.flag}) compadd -- ${e.options.map(shQuote).join(' ')}; return ;;`)
    .join('\n')
  const flagCases = schema.subcommands
    .map((s) => `    ${s.name}) compadd -- ${s.flags.map((f) => shQuote(`--${f.name}`)).join(' ')} ;;`)
    .join('\n')

  return `# ${schema.name} zsh completion — generated from the CLI's own command definitions.
# Add to your shell config: eval "$(${schema.name} completion zsh)"
${fn}() {
  local cur prev sub
  cur="\${words[CURRENT]}"
  prev="\${words[CURRENT-1]}"
  sub="\${words[2]}"

  if (( CURRENT == 2 )); then
    compadd -- ${subNames}
    return
  fi

  case "$sub:$prev" in
${enumCases}
  esac

  case "$sub" in
${flagCases}
  esac
}
compdef ${fn} ${schema.name}
`
}

export function generateFishCompletion(schema: CompletionSchema): string {
  const lines: string[] = [
    `# ${schema.name} fish completion — generated from the CLI's own command definitions.`,
    `# Add to your shell config: ${schema.name} completion fish | source`,
    `complete -c ${schema.name} -f`,
  ]
  for (const sub of schema.subcommands) {
    const desc = sub.description ? ` -d ${shQuote(sub.description)}` : ''
    lines.push(`complete -c ${schema.name} -n '__fish_use_subcommand' -a ${shQuote(sub.name)}${desc}`)
  }
  for (const sub of schema.subcommands) {
    for (const flag of sub.flags) {
      const condition = shQuote(`__fish_seen_subcommand_from ${sub.name}`)
      const values = flag.options ? ` -a ${shQuote(flag.options.join(' '))}` : ''
      lines.push(`complete -c ${schema.name} -n ${condition} -l ${flag.name}${values}`)
    }
  }
  return lines.join('\n') + '\n'
}

export function generateCompletion(schema: CompletionSchema, shell: Shell): string {
  if (shell === 'bash') return generateBashCompletion(schema)
  if (shell === 'zsh') return generateZshCompletion(schema)
  return generateFishCompletion(schema)
}
