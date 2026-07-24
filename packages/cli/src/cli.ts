#!/usr/bin/env node
import { cancel, confirm, intro, isCancel, log as clackLog, outro, select } from '@clack/prompts'
import { defineCommand, runMain } from 'citty'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { buildPushUrl, resolvePushOptions, type PushOptions, type RawPushArgs } from './args'
import { clearGlobalConfig, loadGlobalConfig, loadProjectConfig, saveGlobalConfig, saveProjectConfig, type ProjectConfig } from './config'
import { exec } from './exec'
import { login } from './login'
import { fillMissingPushDefaults, fillMissingSafariBuildDefaults, promptText, requiredField } from './prompts'
import { resolveSafariBuildOptions, safariDefaultsChanged, type RawSafariBuildArgs } from './safari-build-args'
import { runSafariBuild } from './safari-build'

async function resolveApiUrl(flagApiUrl?: string): Promise<string> {
  const [globalConfig, projectConfig] = await Promise.all([loadGlobalConfig(), loadProjectConfig()])
  return (flagApiUrl ?? process.env.EXTPORT_API_URL ?? projectConfig.apiUrl ?? globalConfig.apiUrl ?? 'https://dash.extport.dev').replace(/\/+$/, '')
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

async function runPush(raw: RawPushArgs): Promise<void> {
  const [globalConfig, projectConfig] = await Promise.all([loadGlobalConfig(), loadProjectConfig()])
  let defaults = { extension: projectConfig.extension, apiKey: globalConfig.apiKey, apiUrl: projectConfig.apiUrl ?? globalConfig.apiUrl }
  if (process.stdin.isTTY) {
    defaults = { ...defaults, ...(await fillMissingPushDefaults(raw, process.env, defaults)) }
  }

  const options = resolvePushOptions(raw, process.env, defaults)
  const request = await buildPushRequest(options)

  const target = `${options.extension}@${options.version}${options.store ? ` (${options.store})` : ''}`
  console.log(`pushing ${options.file ?? '(no file)'} → ${target}`)

  const res = await fetch(buildPushUrl(options), { method: 'POST', headers: request.headers, body: request.body })

  let json: { artifact?: { id: string; sha256: string | null }; deduplicated?: boolean; warning?: string; error?: string }
  try {
    json = (await res.json()) as typeof json
  } catch {
    throw new Error(`unexpected response (${res.status})`)
  }

  if (res.status === 201) {
    console.log(`uploaded ${target} (${request.label})`)
  } else if (res.ok && json.deduplicated) {
    console.log(`already uploaded ${target} — identical content, nothing to do`)
  } else {
    throw new Error(json.error ?? `upload failed (${res.status})`)
  }
  if (json.warning) console.log(`warning: ${json.warning}`)
}

async function runSafariBuildCommand(raw: RawSafariBuildArgs): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error(`safari-build requires macOS (xcodebuild is not available on ${process.platform})`)
  }

  const projectConfig = await loadProjectConfig()
  const existingSafariDefaults = projectConfig.safari ?? {}
  let defaults = { ...existingSafariDefaults }
  if (process.stdin.isTTY) {
    defaults = { ...defaults, ...(await fillMissingSafariBuildDefaults(raw, process.env, defaults)) }
    // None of these four are secrets (the .p8 key itself stays external,
    // resolved separately) — save them so the same questions aren't asked
    // again next time, exactly like `extport init` already does.
    if (safariDefaultsChanged(existingSafariDefaults, defaults)) {
      await saveProjectConfig({ ...projectConfig, safari: defaults })
      console.log('Saved to extport.config.json for next time.')
    }
  }

  const options = resolveSafariBuildOptions(raw, process.env, defaults)
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

async function runLogin(flagApiUrl?: string): Promise<void> {
  const apiUrl = await resolveApiUrl(flagApiUrl)
  console.log(`Opening ${apiUrl} to authorize this machine…`)
  const result = await login(apiUrl)
  await saveGlobalConfig({ apiKey: result.apiKey, apiUrl })
  const me = await fetchMe(apiUrl, result.apiKey)
  console.log(me ? `Logged in as ${me.tenant.name} (${me.tenant.plan}).` : 'Logged in.')
}

async function runLogout(): Promise<void> {
  await clearGlobalConfig()
  console.log('Logged out locally.')
  console.log('Note: the API key itself stays valid until revoked from Settings → API keys in the dashboard.')
}

async function runWhoami(flagApiUrl?: string, flagApiKey?: string): Promise<void> {
  const globalConfig = await loadGlobalConfig()
  const apiKey = flagApiKey ?? process.env.EXTPORT_API_KEY ?? globalConfig.apiKey
  if (!apiKey) throw new Error("not logged in — run 'extport login'")
  const apiUrl = await resolveApiUrl(flagApiUrl)
  const me = await fetchMe(apiUrl, apiKey)
  if (!me) throw new Error('could not verify credentials — the key may be invalid or revoked')
  console.log(`${me.tenant.name} (${me.tenant.plan}) — ${apiUrl}`)
}

async function runInit(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error('extport init is interactive and needs a terminal (no TTY detected)')
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
    const result = await login(apiUrl)
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

const apiUrlArg = { type: 'string', description: 'Platform URL (or env EXTPORT_API_URL)' } as const

// citty's own error handling prints the raw Error object (full stack trace) —
// this keeps the CLI's previous clean `error: <message>` + exit 1 UX.
function withCleanErrors<A>(fn: (args: A) => Promise<void>): (ctx: { args: A }) => Promise<void> {
  return async ({ args }) => {
    try {
      await fn(args)
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }
}

const main = defineCommand({
  meta: { name: 'extport', description: 'Publish browser extension artifacts' },
  subCommands: {
    login: defineCommand({
      meta: { name: 'login', description: 'Authorize this machine via your browser' },
      args: { 'api-url': apiUrlArg },
      run: withCleanErrors((args) => runLogin(args['api-url'] as string | undefined)),
    }),
    logout: defineCommand({
      meta: { name: 'logout', description: 'Forget the locally-stored API key' },
      run: withCleanErrors(() => runLogout()),
    }),
    whoami: defineCommand({
      meta: { name: 'whoami', description: 'Show which tenant the current credentials belong to' },
      args: {
        'api-url': apiUrlArg,
        'api-key': { type: 'string', description: 'API key sk_live_… (or env EXTPORT_API_KEY, or run "extport login")' },
      },
      run: withCleanErrors((args) => runWhoami(args['api-url'] as string | undefined, args['api-key'] as string | undefined)),
    }),
    init: defineCommand({
      meta: { name: 'init', description: 'Interactive setup — writes extport.config.json' },
      run: withCleanErrors(() => runInit()),
    }),
    push: defineCommand({
      meta: { name: 'push', description: 'Upload an artifact to extport' },
      args: {
        file: { type: 'positional', description: "Path to the zip file (omit only for --store safari — its binary reaches App Store Connect via 'extport safari-build')", required: false },
        extension: { type: 'string', description: 'Target extension, id or slug (required — or extport.config.json\'s "extension")' },
        version: { type: 'string', description: 'Artifact version, 1-4 dot-separated integers (required)' },
        store: { type: 'enum', options: ['chrome', 'firefox', 'edge', 'safari'], description: 'Omit for a universal zip pushed to every configured store' },
        'source-zip': { type: 'string', description: 'Source code zip for AMO review (--store firefox only)' },
        'api-url': apiUrlArg,
        'api-key': { type: 'string', description: 'API key sk_live_… (or env EXTPORT_API_KEY, or run "extport login")' },
      },
      run: withCleanErrors((args) =>
        runPush({
          file: args.file as string | undefined,
          extension: args.extension as string | undefined,
          version: args.version as string | undefined,
          store: args.store as string | undefined,
          sourceZip: args['source-zip'] as string | undefined,
          apiUrl: args['api-url'] as string | undefined,
          apiKey: args['api-key'] as string | undefined,
        }),
      ),
    }),
    'safari-build': defineCommand({
      meta: { name: 'safari-build', description: "Build, sign, and upload a Safari extension to App Store Connect — never submits for review, that's reconcile's job" },
      args: {
        'project-path': { type: 'string', description: 'Directory containing the .xcodeproj (required — or extport.config.json\'s "safari.projectPath")' },
        'team-id': { type: 'string', description: 'Apple Developer Team ID (required, or config)' },
        'issuer-id': { type: 'string', description: 'App Store Connect issuer id (or env ASC_ISSUER_ID, or config)' },
        'key-id': { type: 'string', description: 'App Store Connect key id (or env ASC_KEY_ID, or config)' },
        'key-path': {
          type: 'string',
          description: ".p8 key file (or env ASC_KEY_PATH; defaults to Apple's own tooling search order: ./private_keys, ~/private_keys, ~/.private_keys, ~/.appstoreconnect/private_keys)",
        },
        platform: { type: 'enum', options: ['macos', 'ios'], description: 'Build only one platform (default: every platform the Xcode project ships)' },
        version: { type: 'string', description: "Fail loudly if the built app's version doesn't match (safety net — extport never stamps it)" },
        'macos-deployment-target': { type: 'string', default: '12.0', description: 'Minimum macOS version to build for' },
        debug: { type: 'boolean', description: "Stream xcodebuild's full raw output live instead of only on failure" },
      },
      run: withCleanErrors((args) =>
        runSafariBuildCommand({
          projectPath: args['project-path'] as string | undefined,
          teamId: args['team-id'] as string | undefined,
          issuerId: args['issuer-id'] as string | undefined,
          keyId: args['key-id'] as string | undefined,
          keyPath: args['key-path'] as string | undefined,
          platform: args.platform as 'macos' | 'ios' | undefined,
          version: args.version as string | undefined,
          // citty's default: '12.0' guarantees this is always a real string at runtime.
          macosDeploymentTarget: args['macos-deployment-target'] as unknown as string,
          debug: args.debug as boolean | undefined,
        }),
      ),
    }),
  },
})

void runMain(main)
