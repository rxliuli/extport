#!/usr/bin/env node
import { cancel, confirm, intro, isCancel, log as clackLog, outro, select } from '@clack/prompts'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { buildPushUrl, parsePushArgs, USAGE, type PushOptions } from './args.js'
import { clearGlobalConfig, loadGlobalConfig, loadProjectConfig, saveGlobalConfig, saveProjectConfig, type ProjectConfig } from './config.js'
import { exec } from './exec.js'
import { login } from './login.js'
import { fillMissingPushDefaults, fillMissingSafariBuildDefaults, promptText, requiredField } from './prompts.js'
import { SAFARI_BUILD_USAGE, parseSafariBuildArgs } from './safari-build-args.js'
import { runSafariBuild } from './safari-build.js'

const TOP_USAGE = `extport — publish browser extension artifacts

Commands:
  login          Authorize this machine via your browser
  logout         Forget the locally-stored API key
  whoami         Show which tenant the current credentials belong to
  init           Interactive setup — writes extport.config.json
  push           Upload an artifact to extport
  safari-build   Build, sign, and upload a Safari extension to App Store Connect

Run "extport <command> --help" for command-specific options.
`

function fail(message: string): void {
  console.error(`error: ${message}`)
  process.exit(1)
}

/** Just enough to read --api-url/--api-key out of login/logout/whoami's short arg lists. */
function parseSimpleFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg?.startsWith('--')) {
      const value = argv[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        flags[arg.slice(2)] = value
        i++
      }
    }
  }
  return flags
}

async function resolveApiUrl(flags: Record<string, string>): Promise<string> {
  const [globalConfig, projectConfig] = await Promise.all([loadGlobalConfig(), loadProjectConfig()])
  return (flags['api-url'] ?? process.env.EXTPORT_API_URL ?? projectConfig.apiUrl ?? globalConfig.apiUrl ?? 'https://dash.extport.dev').replace(/\/+$/, '')
}

interface Me {
  authType: string
  tenant: { id: string; name: string; plan: string }
  user: { id: string; email: string; displayName: string | null } | null
}

async function fetchMe(apiUrl: string, apiKey: string): Promise<Me | null> {
  try {
    const res = await fetch(new URL('/api/v1/me', apiUrl), { headers: { authorization: `Bearer ${apiKey}` } })
    if (!res.ok) return null
    return (await res.json()) as Me
  } catch {
    return null
  }
}

interface PushRequest {
  headers: Record<string, string>
  body?: Uint8Array | FormData
  label: string
}

async function readZip(path: string): Promise<Uint8Array<ArrayBuffer>> {
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch {
    throw new Error(`cannot read file: ${path}`)
  }
  return buf.slice()
}

async function buildPushRequest(options: PushOptions): Promise<PushRequest> {
  const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}` }

  if (!options.file) {
    // Safari: no binary travels through extport — this registers version intent only.
    return { headers, label: 'no file (version intent only)' }
  }

  const bytes = await readZip(options.file)
  if (options.sourceZip) {
    const sourceBytes = await readZip(options.sourceZip)
    const form = new FormData()
    form.set('file', new Blob([bytes]), 'extension.zip')
    form.set('source', new Blob([sourceBytes]), 'source.zip')
    return { headers, body: form, label: `${bytes.length} bytes + ${sourceBytes.length} source bytes` }
  }

  headers['content-type'] = 'application/zip'
  return { headers, body: bytes, label: `${bytes.length} bytes` }
}

async function runPush(rest: string[]): Promise<void> {
  const [globalConfig, projectConfig] = await Promise.all([loadGlobalConfig(), loadProjectConfig()])
  let defaults = { extension: projectConfig.extension, apiKey: globalConfig.apiKey, apiUrl: projectConfig.apiUrl ?? globalConfig.apiUrl }
  if (process.stdin.isTTY) {
    try {
      defaults = { ...defaults, ...(await fillMissingPushDefaults(rest, process.env, defaults)) }
    } catch (err) {
      fail((err as Error).message)
      return
    }
  }

  let options: PushOptions
  try {
    options = parsePushArgs(rest, process.env, defaults)
  } catch (err) {
    fail(`${(err as Error).message}\n\n${USAGE}`)
    return
  }

  let request: PushRequest
  try {
    request = await buildPushRequest(options)
  } catch (err) {
    fail((err as Error).message)
    return
  }

  const target = `${options.extension}@${options.version}${options.store ? ` (${options.store})` : ''}`
  console.log(`pushing ${options.file ?? '(no file)'} → ${target}`)

  const res = await fetch(buildPushUrl(options), { method: 'POST', headers: request.headers, body: request.body })

  let json: { artifact?: { id: string; sha256: string | null }; deduplicated?: boolean; error?: string }
  try {
    json = (await res.json()) as typeof json
  } catch {
    fail(`unexpected response (${res.status})`)
    return
  }

  if (res.status === 201) {
    console.log(`uploaded ${target} (${request.label})`)
  } else if (res.ok && json.deduplicated) {
    console.log(`already uploaded ${target} — identical content, nothing to do`)
  } else {
    fail(`${json.error ?? `upload failed (${res.status})`}`)
  }
}

async function runSafariBuildCommand(rest: string[]): Promise<void> {
  if (process.platform !== 'darwin') {
    fail(`safari-build requires macOS (xcodebuild is not available on ${process.platform})`)
    return
  }

  const projectConfig = await loadProjectConfig()
  let defaults = { ...projectConfig.safari }
  if (process.stdin.isTTY) {
    try {
      defaults = { ...defaults, ...(await fillMissingSafariBuildDefaults(rest, process.env, defaults)) }
    } catch (err) {
      fail((err as Error).message)
      return
    }
  }

  let options
  try {
    options = parseSafariBuildArgs(rest, process.env, defaults)
  } catch (err) {
    fail(`${(err as Error).message}\n\n${SAFARI_BUILD_USAGE}`)
    return
  }

  const results = await runSafariBuild(options, exec)

  console.log('')
  let anyFailed = false
  for (const result of results) {
    if (result.ok) {
      console.log(`✅ ${result.platform}: uploaded`)
    } else {
      anyFailed = true
      console.log(`❌ ${result.platform}: ${result.error}`)
    }
  }
  if (anyFailed) process.exit(1)
}

async function runLogin(rest: string[]): Promise<void> {
  const flags = parseSimpleFlags(rest)
  const apiUrl = await resolveApiUrl(flags)
  console.log(`Opening ${apiUrl} to authorize this machine…`)
  let result
  try {
    result = await login(apiUrl)
  } catch (err) {
    fail((err as Error).message)
    return
  }
  await saveGlobalConfig({ apiKey: result.apiKey, apiUrl })
  const me = await fetchMe(apiUrl, result.apiKey)
  console.log(me ? `Logged in as ${me.tenant.name} (${me.tenant.plan}).` : 'Logged in.')
}

async function runLogout(): Promise<void> {
  await clearGlobalConfig()
  console.log('Logged out locally.')
  console.log('Note: the API key itself stays valid until revoked from Settings → API keys in the dashboard.')
}

async function runWhoami(rest: string[]): Promise<void> {
  const flags = parseSimpleFlags(rest)
  const globalConfig = await loadGlobalConfig()
  const apiKey = flags['api-key'] ?? process.env.EXTPORT_API_KEY ?? globalConfig.apiKey
  if (!apiKey) {
    fail("not logged in — run 'extport login'")
    return
  }
  const apiUrl = await resolveApiUrl(flags)
  const me = await fetchMe(apiUrl, apiKey)
  if (!me) {
    fail('could not verify credentials — the key may be invalid or revoked')
    return
  }
  console.log(`${me.tenant.name} (${me.tenant.plan}) — ${apiUrl}`)
}

async function runInit(): Promise<void> {
  if (!process.stdin.isTTY) {
    fail('extport init is interactive and needs a terminal (no TTY detected)')
    return
  }
  intro('extport init')

  let globalConfig = await loadGlobalConfig()
  const apiUrl = globalConfig.apiUrl ?? 'https://dash.extport.dev'

  if (!globalConfig.apiKey) {
    const shouldLogin = await confirm({ message: 'Not logged in yet — log in now?', initialValue: true })
    if (isCancel(shouldLogin) || !shouldLogin) {
      cancel('extport init needs you to be logged in first — run it again after `extport login`.')
      return
    }
    let result
    try {
      result = await login(apiUrl)
    } catch (err) {
      cancel((err as Error).message)
      return
    }
    globalConfig = { apiKey: result.apiKey, apiUrl }
    await saveGlobalConfig(globalConfig)
  }

  const me = await fetchMe(apiUrl, globalConfig.apiKey!)
  if (me) clackLog.success(`Logged in as ${me.tenant.name} (${me.tenant.plan}).`)

  const existing = await fetch(new URL('/api/v1/extensions', apiUrl), { headers: { authorization: `Bearer ${globalConfig.apiKey}` } })
    .then((res) => (res.ok ? res.json() : { extensions: [] }))
    .then((body) => (body as { extensions?: { slug: string; name: string }[] }).extensions ?? [])
    .catch(() => [])

  let extension: string
  if (existing.length > 0) {
    const OTHER = '__other__'
    const choice = await select({
      message: 'Which extension is this project for?',
      options: [...existing.map((e) => ({ value: e.slug, label: `${e.name} (${e.slug})` })), { value: OTHER, label: 'Something else (type an id/slug)' }],
    })
    if (isCancel(choice)) {
      cancel('cancelled')
      return
    }
    extension = choice === OTHER ? await promptText('Extension id or slug:', { validate: requiredField('Extension') }) : choice
  } else {
    extension = await promptText('Extension id or slug:', { validate: requiredField('Extension') })
  }

  const wantsSafari = await confirm({ message: 'Does this project publish to Safari (App Store Connect)?', initialValue: false })
  if (isCancel(wantsSafari)) {
    cancel('cancelled')
    return
  }

  const config: ProjectConfig = { extension }
  if (wantsSafari) {
    config.safari = {
      projectPath: await promptText('Path to the Xcode project directory:', { placeholder: './ios', validate: requiredField('Project path') }),
      teamId: await promptText('Apple Developer Team ID:', { validate: requiredField('Team ID') }),
      issuerId: await promptText('App Store Connect issuer id:', { validate: requiredField('Issuer id') }),
      keyId: await promptText('App Store Connect key id:', { validate: requiredField('Key id') }),
    }
  }

  await saveProjectConfig(config)
  outro('Wrote extport.config.json — commit it, it has no secrets.')
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(TOP_USAGE)
    return
  }
  if (command === 'login') return runLogin(rest)
  if (command === 'logout') return runLogout()
  if (command === 'whoami') return runWhoami(rest)
  if (command === 'init') return runInit()
  if (command === 'push') {
    if (rest[0] === '--help' || rest[0] === '-h') {
      console.log(USAGE)
      return
    }
    return runPush(rest)
  }
  if (command === 'safari-build') {
    if (rest[0] === '--help' || rest[0] === '-h') {
      console.log(SAFARI_BUILD_USAGE)
      return
    }
    return runSafariBuildCommand(rest)
  }
  fail(`unknown command "${command}"\n\n${TOP_USAGE}`)
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
