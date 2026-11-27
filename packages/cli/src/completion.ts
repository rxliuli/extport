import { execSync } from 'node:child_process'
import type { ArgDef, ArgsDef, CommandDef, CommandMeta } from 'citty'

export type Shell = 'bash' | 'zsh' | 'fish'

/**
 * Maps a process "comm" name (as `ps -o comm=` reports it) to a known
 * shell. Login shells prefix argv[0] with "-" (e.g. "-zsh") to mark
 * themselves as such — stripped here, it's irrelevant to what shell it is.
 * Pulled out as its own pure function so the parsing logic is unit
 * testable without actually spawning `ps`.
 */
export function parseShellFromComm(comm: string): Shell | undefined {
  const base = comm.trim().split('/').pop()?.replace(/^-/, '')
  if (base === 'bash' || base === 'zsh' || base === 'fish') return base
  return undefined
}

/**
 * $ZSH_VERSION/$BASH_VERSION/$FISH_VERSION looked like the obvious signal
 * but turned out not to be one: confirmed against a real shell that none
 * of the three are actually exported to a child process's environment by
 * default (they're shell-internal parameters, not env vars) — a plain
 * `node -e "console.log(process.env.BASH_VERSION)"` under bash prints
 * undefined. $SHELL isn't reliable either: it's the user's configured
 * *login* shell, not necessarily the one this process is actually running
 * under (e.g. a bash script invoked from an interactive zsh session).
 *
 * What's actually reliable: asking the OS what the immediate parent
 * process (`process.ppid` — the shell that launched this one) is
 * currently named, via `ps`. Confirmed against a real terminal session —
 * this resolves correctly regardless of the user's login shell. Falls
 * back to $SHELL only if `ps` itself is unavailable (e.g. a minimal
 * container image).
 */
export function detectShell(env: Record<string, string | undefined>, ppid: number = process.ppid): Shell | undefined {
  try {
    const comm = execSync(`ps -p ${ppid} -o comm=`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const fromParent = parseShellFromComm(comm)
    if (fromParent) return fromParent
  } catch {
    // ps unavailable, or the pid is already gone — fall through to $SHELL.
  }
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
  subcommands?: CompletionSubcommand[]
}

export interface CompletionSchema {
  name: string
  subcommands: CompletionSubcommand[]
}

function extractSubcommands(subCommandsDef: Record<string, CommandDef>): CompletionSubcommand[] {
  return Object.entries(subCommandsDef).map(([key, sub]) => {
    const subMeta = sub.meta as CommandMeta | undefined
    const argsDef = (sub.args as ArgsDef | undefined) ?? {}
    const flags: CompletionFlag[] = Object.entries(argsDef)
      .filter(([, def]) => (def as ArgDef).type !== 'positional')
      .map(([flagName, def]) => ({
        name: flagName,
        options: (def as ArgDef).type === 'enum' ? (def as ArgDef & { options: string[] }).options : undefined,
      }))
    const nestedDef = (sub.subCommands as Record<string, CommandDef> | undefined) ?? {}
    const nested = Object.keys(nestedDef).length > 0 ? extractSubcommands(nestedDef) : undefined
    return {
      name: subMeta?.name ?? key,
      description: subMeta?.description,
      flags,
      ...(nested ? { subcommands: nested } : {}),
    }
  })
}

/**
 * Walks a citty CommandDef's subCommands (including one level of nested
 * subcommands, e.g. `extport port safari`), keeping just what shell completion
 * needs (subcommand names, flag names, enum values). Assumes
 * subCommands/args/meta are plain objects, never citty's Resolvable
 * function/promise form — true for every command this CLI defines, so that
 * form is deliberately left unhandled rather than guessed at.
 */
export function extractCompletionSchema(cmd: CommandDef): CompletionSchema {
  const meta = cmd.meta as CommandMeta | undefined
  const subCommandsDef = (cmd.subCommands as Record<string, CommandDef> | undefined) ?? {}
  return { name: meta?.name ?? 'cli', subcommands: extractSubcommands(subCommandsDef) }
}

/** Single-quoted-string safe in bash/zsh/fish alike: close, escaped quote, reopen. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

function enumCompletions(schema: CompletionSchema): { subcommand: string; flag: string; options: string[] }[] {
  return schema.subcommands.flatMap((sub) =>
    sub.flags.filter((f) => f.options).map((f) => ({ subcommand: sub.name, flag: f.name, options: f.options! })),
  )
}

function nestedSubcommands(schema: CompletionSchema): { parent: string; child: CompletionSubcommand }[] {
  return schema.subcommands.flatMap((sub) => (sub.subcommands ?? []).map((child) => ({ parent: sub.name, child })))
}

export function generateBashCompletion(schema: CompletionSchema): string {
  const fn = `_${schema.name}_completions`
  const subNames = schema.subcommands.map((s) => s.name).join(' ')
  const enumCases = enumCompletions(schema)
    .map(
      (e) =>
        `    ${e.subcommand}:--${e.flag}) COMPREPLY=( $(compgen -W "${e.options.join(' ')}" -- "$cur") ); return ;;`,
    )
    .join('\n')
  const flagCases = schema.subcommands
    .map(
      (s) => `    ${s.name}) COMPREPLY=( $(compgen -W "${s.flags.map((f) => `--${f.name}`).join(' ')}" -- "$cur") ) ;;`,
    )
    .join('\n')

  const nestedParents = schema.subcommands.filter((s) => s.subcommands && s.subcommands.length > 0)
  const nestedEntries = nestedSubcommands(schema)
  const nestedBlock =
    nestedParents.length === 0
      ? ''
      : `\n  if [ "$COMP_CWORD" -eq 2 ]; then
    case "$sub" in
${nestedParents.map((p) => `      ${p.name}) COMPREPLY=( $(compgen -W "${p.subcommands!.map((c) => c.name).join(' ')}" -- "$cur") ); return ;;`).join('\n')}
    esac
  fi

  local sub2="\${COMP_WORDS[2]}"
  case "$sub:$sub2:$prev" in
${nestedEntries
  .flatMap(({ parent, child }) =>
    child.flags
      .filter((f) => f.options)
      .map(
        (f) =>
          `    ${parent}:${child.name}:--${f.name}) COMPREPLY=( $(compgen -W "${f.options!.join(' ')}" -- "$cur") ); return ;;`,
      ),
  )
  .join('\n')}
  esac

  case "$sub:$sub2" in
${nestedEntries
  .map(
    ({ parent, child }) =>
      `    ${parent}:${child.name}) COMPREPLY=( $(compgen -W "${child.flags.map((f) => `--${f.name}`).join(' ')}" -- "$cur") ); return ;;`,
  )
  .join('\n')}
  esac\n`

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
${nestedBlock}
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

  const nestedParents = schema.subcommands.filter((s) => s.subcommands && s.subcommands.length > 0)
  const nestedEntries = nestedSubcommands(schema)
  const nestedBlock =
    nestedParents.length === 0
      ? ''
      : `\n  if (( CURRENT == 3 )); then
    case "$sub" in
${nestedParents.map((p) => `      ${p.name}) compadd -- ${p.subcommands!.map((c) => shQuote(c.name)).join(' ')}; return ;;`).join('\n')}
    esac
  fi

  local sub2="\${words[3]}"
  case "$sub:$sub2:$prev" in
${nestedEntries
  .flatMap(({ parent, child }) =>
    child.flags
      .filter((f) => f.options)
      .map(
        (f) => `    ${parent}:${child.name}:--${f.name}) compadd -- ${f.options!.map(shQuote).join(' ')}; return ;;`,
      ),
  )
  .join('\n')}
  esac

  case "$sub:$sub2" in
${nestedEntries
  .map(
    ({ parent, child }) =>
      `    ${parent}:${child.name}) compadd -- ${child.flags.map((f) => shQuote(`--${f.name}`)).join(' ')}; return ;;`,
  )
  .join('\n')}
  esac\n`

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
${nestedBlock}
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
    if (sub.subcommands && sub.subcommands.length > 0) {
      const childNames = sub.subcommands.map((c) => c.name).join(' ')
      const childCondition = shQuote(
        `__fish_seen_subcommand_from ${sub.name}; and not __fish_seen_subcommand_from ${childNames}`,
      )
      for (const child of sub.subcommands) {
        const desc = child.description ? ` -d ${shQuote(child.description)}` : ''
        lines.push(`complete -c ${schema.name} -n ${childCondition} -a ${shQuote(child.name)}${desc}`)
      }
      for (const child of sub.subcommands) {
        const flagCondition = shQuote(
          `__fish_seen_subcommand_from ${sub.name}; and __fish_seen_subcommand_from ${child.name}`,
        )
        for (const flag of child.flags) {
          const values = flag.options ? ` -a ${shQuote(flag.options.join(' '))}` : ''
          lines.push(`complete -c ${schema.name} -n ${flagCondition} -l ${flag.name}${values}`)
        }
      }
    }
  }
  return lines.join('\n') + '\n'
}

export function generateCompletion(schema: CompletionSchema, shell: Shell): string {
  if (shell === 'bash') return generateBashCompletion(schema)
  if (shell === 'zsh') return generateZshCompletion(schema)
  return generateFishCompletion(schema)
}
