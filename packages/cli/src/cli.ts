#!/usr/bin/env node
import { cancel, confirm, intro, isCancel, log as clackLog, outro, select, spinner } from '@clack/prompts'
import { defineCommand, runMain } from 'citty'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import pkg from '../package.json' with { type: 'json' }
import {
  buildPushUrl,
  resolvePushContext,
  resolvePushOptions,
  type PushDefaults,
  type PushOptions,
  type RawPushArgs,
} from './args'
import {
  clearGlobalConfig,
  DEFAULT_API_URL,
  loadGlobalConfig,
  loadProjectConfig,
  normalizeApiUrl,
  resolveApiUrl,
  resolveCredentials,
  resolveStoredApiKey,
  saveGlobalConfig,
  saveProjectConfig,
  warnIfProjectApiUrl,
} from './config'
import { existsSync } from 'node:fs'
import { createExtension, downloadTemplate, fetchExtensions, patchScaffold, slugify } from './scaffold'
import { detectShell, extractCompletionSchema, generateCompletion, type Shell } from './completion'
import { exec } from './exec'
import { fetchEnabledTargets } from './extensions-api'
import { login } from './login'
import {
  fillMissingPushDefaults,
  fillMissingSafariBuildDefaults,
  PromptCancelled,
  promptText,
  requiredField,
} from './prompts'
import { resolveSafariBuildOptions, safariDefaultsChanged, type RawSafariBuildArgs } from './safari-build-args'
import { runSafariBuild } from './safari-build'
import { resolveSafariInstallOptions, type RawSafariInstallArgs } from './safari-install-args'
import { runSafariInstall } from './safari-install'
import type { IosDevice } from './safari-install-devices'
import type { SigningIdentity } from './safari-install-signing'
import { inferPushDefaults } from './wxt-project'

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

async function pushOnce(options: PushOptions): Promise<void> {
  const request = await buildPushRequest(options)

  const target = `${options.extension}@${options.version}${options.store ? ` (${options.store})` : ''}`
  console.log(`pushing ${options.file ?? '(no file)'} → ${target}`)

  const res = await fetch(buildPushUrl(options), { method: 'POST', headers: request.headers, body: request.body })

  let json: {
    artifact?: { id: string; sha256: string | null }
    deduplicated?: boolean
    warning?: string
    error?: string
  }
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

/**
 * Neither --file nor --store given: look up every enabled target configured
 * for this extension and push each one, inferring its zip/version from the
 * WXT project (docs/... push's "just run it" mode). A single --file with no
 * --store still means the existing universal push below, untouched — this
 * only kicks in when nothing at all was specified.
 */
async function runPushAll(raw: RawPushArgs, defaults: PushDefaults): Promise<void> {
  const { extension, apiUrl, apiKey } = resolvePushContext(raw, process.env, defaults)
  const targets = await fetchEnabledTargets(apiUrl, apiKey, extension)
  if (targets.length === 0) {
    throw new Error(
      `no enabled store targets configured for "${extension}" — pass --store/--file explicitly, or add a target in the dashboard`,
    )
  }

  console.log(`no --store given — pushing to every configured target: ${targets.map((t) => t.store).join(', ')}`)
  let anyFailed = false
  for (const target of targets) {
    try {
      const inferred = await inferPushDefaults(raw, target.store, process.cwd())
      const options = resolvePushOptions({ ...raw, store: target.store }, process.env, { ...defaults, ...inferred })
      await pushOnce(options)
    } catch (err) {
      anyFailed = true
      console.log(`❌ ${target.store}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (anyFailed) process.exit(1)
}

async function runPush(raw: RawPushArgs): Promise<void> {
  const [globalConfig, projectConfig] = await Promise.all([loadGlobalConfig(), loadProjectConfig()])
  warnIfProjectApiUrl(projectConfig)
  const targetApiUrl = resolveApiUrl({ flagApiUrl: raw.apiUrl, env: process.env, globalConfig })
  let effectiveRaw = raw
  let defaults: PushDefaults = {
    extension: projectConfig.extension,
    apiKey: globalConfig.apiKey,
    apiUrl: globalConfig.apiUrl,
  }
  if (process.stdin.isTTY) {
    const matchedStoredKey = resolveStoredApiKey(globalConfig, targetApiUrl)
    const filled = await fillMissingPushDefaults(raw, process.env, {
      extension: projectConfig.extension,
      apiKey: matchedStoredKey,
    })
    defaults = { ...defaults, extension: filled.extension }
    if (!raw.apiKey && !process.env.EXTPORT_API_KEY && !matchedStoredKey && filled.apiKey) {
      effectiveRaw = { ...raw, apiKey: filled.apiKey }
    }
  }

  if (!effectiveRaw.file && !effectiveRaw.store) {
    await runPushAll(effectiveRaw, defaults)
    return
  }

  const inferred = await inferPushDefaults(effectiveRaw, effectiveRaw.store, process.cwd())
  const options = resolvePushOptions(effectiveRaw, process.env, { ...defaults, ...inferred })
  await pushOnce(options)
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

async function promptSelectSigningIdentity(
  identities: SigningIdentity[],
  platform: 'macos' | 'ios',
): Promise<SigningIdentity | 'none'> {
  const NONE = '__none__'
  const choice = await select({
    message: `Select a Keychain signing certificate for ${platform}:`,
    options: [
      ...identities.map((id) => ({
        value: id.sha1,
        label: id.name,
        hint: id.teamId ? `Team ${id.teamId}` : id.sha1.slice(0, 8),
      })),
      {
        value: NONE,
        label: platform === 'macos' ? 'No signing (ad-hoc)' : 'No signing (unsigned .ipa)',
        hint: platform === 'macos' ? 'requires Safari "Allow Unsigned Extensions"' : 'requires --output',
      },
    ],
  })
  if (isCancel(choice)) throw new PromptCancelled()
  if (choice === NONE) return 'none'
  return identities.find((id) => id.sha1 === choice)!
}

async function promptSelectIosDevice(devices: IosDevice[]): Promise<IosDevice> {
  const choice = await select({
    message: 'Select an iOS device to install onto:',
    options: devices.map((device) => ({
      value: device.identifier,
      label: device.name,
      hint: [
        device.model,
        device.osVersion ? `iOS ${device.osVersion}` : undefined,
        device.connected ? 'connected' : 'paired',
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  })
  if (isCancel(choice)) throw new PromptCancelled()
  return devices.find((device) => device.identifier === choice)!
}

async function runPortSafariCommand(raw: RawSafariInstallArgs): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error(`extport port safari requires macOS (Xcode tools are not available on ${process.platform})`)
  }
  const options = resolveSafariInstallOptions(raw)
  await runSafariInstall(options, exec, {
    promptSelectIdentity: promptSelectSigningIdentity,
    promptSelectDevice: promptSelectIosDevice,
  })
}

async function runLogin(flagApiUrl?: string): Promise<void> {
  const [globalConfig, projectConfig] = await Promise.all([loadGlobalConfig(), loadProjectConfig()])
  warnIfProjectApiUrl(projectConfig)
  const apiUrl = resolveApiUrl({ flagApiUrl, env: process.env, globalConfig })
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
  const [globalConfig, projectConfig] = await Promise.all([loadGlobalConfig(), loadProjectConfig()])
  warnIfProjectApiUrl(projectConfig)
  const { apiUrl, apiKey } = resolveCredentials({ flagApiUrl, flagApiKey, env: process.env, globalConfig })
  const me = await fetchMe(apiUrl, apiKey)
  if (!me) throw new Error('could not verify credentials — the key may be invalid or revoked')
  console.log(`${me.tenant.name} (${me.tenant.plan}) — ${apiUrl}`)
}

async function runInit(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error('extport init is interactive and needs a terminal (no TTY detected)')
  }

  // init creates a NEW project in a subdirectory — inside an existing
  // project, the right move is adoption, which is a one-line config edit.
  for (const marker of ['wxt.config.ts', 'extport.config.json', 'package.json']) {
    if (existsSync(marker)) {
      throw new Error(
        `${marker} found here — extport init scaffolds a new project into a subdirectory, run it from a parent directory.\n` +
          "Adopting this existing project instead? Add `extport: { extension: 'ext_…' }` to wxt.config.ts (WXT + @extport/wxt), " +
          'or write extport.config.json by hand — https://github.com/rxliuli/extport#readme',
      )
    }
  }

  intro('extport init — create a new extension project')

  let globalConfig = await loadGlobalConfig()
  const apiUrl = normalizeApiUrl(globalConfig.apiUrl ?? DEFAULT_API_URL)

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

  // One decision: which extension is this? An answer either points at an
  // existing record (dashboard-first workflows) or carries a new name.
  const records = await fetchExtensions(apiUrl, globalConfig.apiKey!)
  const CREATE = '__create__'
  const choice = await select({
    message: 'Extension:',
    options: [
      { value: CREATE, label: '＋ Create a new extension…' },
      ...records.map((e) => ({ value: e.id, label: e.name, hint: e.id })),
    ],
  })
  if (isCancel(choice)) {
    cancel('cancelled')
    return
  }

  let record: { id: string; name: string }
  if (choice === CREATE) {
    const name = (
      await promptText('Extension name:', { placeholder: 'My Extension', validate: requiredField('Name') })
    ).trim()
    const s = spinner()
    s.start('Creating the extension…')
    try {
      record = await createExtension(apiUrl, globalConfig.apiKey!, name)
    } catch (err) {
      s.stop('Could not create the extension.')
      throw err
    }
    s.stop(`Created ${record.name} (${record.id})`)
  } else {
    record = records.find((e) => e.id === choice)!
  }

  // Directory and package name derive from the extension name by the same
  // transform the fleet uses for gecko ids; prompt only when inference
  // degenerates (e.g. a fully non-ASCII name).
  let dir = slugify(record.name)
  if (!dir) {
    dir = await promptText('Directory name:', { validate: requiredField('Directory') })
  }
  if (existsSync(dir)) {
    throw new Error(`./${dir} already exists — move it aside or pick a different extension name`)
  }

  const s = spinner()
  s.start('Downloading browser-extension-template…')
  try {
    await downloadTemplate(dir, exec)
    await patchScaffold(dir, { extensionId: record.id, name: record.name, slug: dir })
  } catch (err) {
    s.stop('Scaffolding failed.')
    throw err
  }
  s.stop(`Scaffolded ./${dir} (bound to ${record.id})`)

  outro(
    [
      'Next:',
      `  cd ${dir}`,
      '  pnpm install   # generates extport.config.json from wxt.config.ts',
      '  pnpm dev',
      '',
      'Publishing: create each store listing once, add targets in the dashboard,',
      'then set the EXTPORT_API_KEY secret for the release workflow.',
    ].join('\n'),
  )
}

async function runCompletionCommand(shellArg: string | undefined): Promise<void> {
  let shell: Shell | undefined
  if (shellArg !== undefined) {
    if (shellArg !== 'bash' && shellArg !== 'zsh' && shellArg !== 'fish') {
      throw new Error(`unknown shell "${shellArg}" — expected bash, zsh, or fish`)
    }
    shell = shellArg
  } else {
    shell = detectShell(process.env)
  }
  if (!shell) {
    throw new Error('could not detect your shell — pass it explicitly: extport completion bash|zsh|fish')
  }
  // `main` (defined below) is only read once this actually runs, well after
  // the module finishes evaluating — safe despite the apparent ordering.
  console.log(generateCompletion(extractCompletionSchema(main), shell))
}

const apiUrlArg = { type: 'string', description: 'Platform URL (or env EXTPORT_API_URL)' } as const

// citty's own error handling prints the raw Error object (full stack trace) —
// this keeps the CLI's previous clean `error: <message>` + exit 1 UX.
function withCleanErrors<A>(
  fn: (args: A, rawArgs: string[]) => Promise<void>,
): (ctx: { args: A; rawArgs: string[] }) => Promise<void> {
  return async ({ args, rawArgs }) => {
    try {
      await fn(args, rawArgs)
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }
}

const main = defineCommand({
  meta: { name: 'extport', version: pkg.version, description: 'Publish browser extension artifacts' },
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
        'api-key': {
          type: 'string',
          description: 'API key sk_live_… (or env EXTPORT_API_KEY, or run "extport login")',
        },
      },
      run: withCleanErrors((args) =>
        runWhoami(args['api-url'] as string | undefined, args['api-key'] as string | undefined),
      ),
    }),
    init: defineCommand({
      meta: {
        name: 'init',
        description: 'Create a new extension project — template scaffold bound to an extport extension from birth',
      },
      run: withCleanErrors(() => runInit()),
    }),
    push: defineCommand({
      meta: {
        name: 'push',
        description:
          'Upload an artifact to extport — omit --file and --store together in a WXT project to push every configured store at once, each inferred from .output/',
      },
      args: {
        file: {
          type: 'positional',
          description:
            'Path to the zip file — omit in a WXT project to use .output/{name}-{version}-{browser}.zip (or always, for --store safari)',
          required: false,
        },
        extension: {
          type: 'string',
          description: 'Target extension id, ext_… (required — or extport.config.json\'s "extension")',
        },
        version: {
          type: 'string',
          description:
            "Artifact version, 1-4 dot-separated integers (or inferred from the zip's manifest.json / package.json)",
        },
        store: {
          type: 'enum',
          options: ['chrome', 'firefox', 'edge', 'safari'],
          description:
            'With --file, omit for one universal zip pushed to every configured store. With neither --file nor --store, pushes every configured store individually',
        },
        'source-zip': {
          type: 'string',
          description:
            'Source code zip for AMO review (--store firefox only; inferred from .output/{name}-{version}-sources.zip when present)',
        },
        'api-url': apiUrlArg,
        'api-key': {
          type: 'string',
          description: 'API key sk_live_… (or env EXTPORT_API_KEY, or run "extport login")',
        },
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
      meta: {
        name: 'safari-build',
        description:
          "Build, sign, and upload a Safari extension to App Store Connect — never submits for review, that's reconcile's job",
      },
      args: {
        'project-path': {
          type: 'string',
          description:
            'Directory containing the .xcodeproj (required — or extport.config.json\'s "safari.projectPath")',
        },
        'team-id': { type: 'string', description: 'Apple Developer Team ID (required, or config)' },
        'issuer-id': { type: 'string', description: 'App Store Connect issuer id (or env ASC_ISSUER_ID, or config)' },
        'key-id': { type: 'string', description: 'App Store Connect key id (or env ASC_KEY_ID, or config)' },
        'key-path': {
          type: 'string',
          description:
            ".p8 key file (or env ASC_KEY_PATH; defaults to Apple's own tooling search order: ./private_keys, ~/private_keys, ~/.private_keys, ~/.appstoreconnect/private_keys)",
        },
        platform: {
          type: 'enum',
          options: ['macos', 'ios'],
          description: 'Build only one platform (default: every platform the Xcode project ships)',
        },
        version: {
          type: 'string',
          description: "Fail loudly if the built app's version doesn't match (safety net — extport never stamps it)",
        },
        'macos-deployment-target': {
          type: 'string',
          default: '12.0',
          description: 'Minimum macOS version to build for',
        },
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
    port: defineCommand({
      meta: {
        name: 'port',
        description:
          'Convert and locally install a Chrome extension for another browser (e.g. extport port safari <source>)',
      },
      subCommands: {
        safari: defineCommand({
          meta: {
            name: 'safari',
            description:
              'Convert any MV3 Chrome extension (CWS URL/ID, .crx, .zip, or directory), sign with an optional local Keychain certificate, and install locally on macOS or iOS',
          },
          args: {
            source: {
              type: 'positional',
              description: 'Chrome Web Store URL, 32-char extension ID, or local directory / .crx / .zip',
              required: true,
            },
            platform: {
              type: 'enum',
              options: ['macos', 'ios'],
              default: 'macos',
              description: 'Target platform to build and install (default: macos)',
            },
            output: {
              type: 'string',
              description:
                'Export the built .app (macOS) or .ipa (iOS) to this directory or path instead of installing',
            },
            sign: {
              type: 'string',
              description: 'Keychain signing identity name substring or SHA-1 (default: auto-discover from Keychain)',
            },
            'no-sign': {
              type: 'boolean',
              description:
                'Skip Keychain lookup: ad-hoc sign on macOS, or export an unsigned .ipa on iOS (requires --output)',
            },
            'team-id': {
              type: 'string',
              description: 'Override the Apple Developer Team ID extracted from the certificate',
            },
            'bundle-id': {
              type: 'string',
              description: 'Override the deterministic bundle identifier (default: dev.extport.<team|local>.<id|slug>)',
            },
            device: {
              type: 'string',
              description: 'Target physical iOS device name, UDID, or identifier (--platform ios only)',
            },
            'keep-project': {
              type: 'string',
              description: 'Copy the generated self-contained Xcode project into this directory',
            },
            'macos-deployment-target': {
              type: 'string',
              default: '12.0',
              description: 'Minimum macOS version to build for',
            },
            debug: {
              type: 'boolean',
              description: 'Stream converter, xcodebuild, and devicectl output live',
            },
          },
          run: withCleanErrors((args, rawArgs) => {
            // citty/mri parses `--no-sign` as `{ sign: false }` and omits `args['no-sign']`,
            // even when `--sign <id>` was also passed. Inspect `rawArgs` so both single
            // `--no-sign` and `--sign + --no-sign` conflict detection work reliably.
            const hasExplicitSign = rawArgs.some((a) => a === '--sign' || a.startsWith('--sign='))
            const hasNoSign = Boolean(args['no-sign']) || args.sign === false || rawArgs.includes('--no-sign')
            const sign = typeof args.sign === 'string' ? args.sign : hasExplicitSign ? '(explicit)' : undefined
            return runPortSafariCommand({
              source: args.source as string | undefined,
              platform: (args.platform as unknown as 'macos' | 'ios' | undefined) ?? 'macos',
              output: args.output as string | undefined,
              sign,
              noSign: hasNoSign,
              teamId: args['team-id'] as string | undefined,
              bundleId: args['bundle-id'] as string | undefined,
              device: args.device as string | undefined,
              keepProject: args['keep-project'] as string | undefined,
              macosDeploymentTarget: args['macos-deployment-target'] as unknown as string,
              debug: args.debug as boolean | undefined,
            })
          }),
        }),
      },
    }),
    completion: defineCommand({
      meta: {
        name: 'completion',
        description: 'Print a shell completion script — e.g. eval "$(extport completion zsh)"',
      },
      args: {
        shell: {
          type: 'positional',
          description: 'bash, zsh, or fish — omit to auto-detect the running shell',
          required: false,
        },
      },
      run: withCleanErrors((args) => runCompletionCommand(args.shell as string | undefined)),
    }),
  },
})

void runMain(main)
