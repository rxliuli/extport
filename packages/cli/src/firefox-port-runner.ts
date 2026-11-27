import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

export interface FirefoxBinary {
  name: string
  channel: 'dev' | 'nightly' | 'firefox' | 'esr' | 'zen' | 'waterfox' | 'librewolf' | 'custom'
  executablePath: string
}

const CHANNEL_ALIASES: Record<string, FirefoxBinary['channel']> = {
  dev: 'dev',
  developer: 'dev',
  'firefox-dev': 'dev',
  'firefox-developer-edition': 'dev',
  nightly: 'nightly',
  'firefox-nightly': 'nightly',
  firefox: 'firefox',
  release: 'firefox',
  esr: 'esr',
  'firefox-esr': 'esr',
  zen: 'zen',
  'zen-browser': 'zen',
  waterfox: 'waterfox',
  librewolf: 'librewolf',
}

function macAppBinaryCandidates(home: string): FirefoxBinary[] {
  const roots = ['/Applications', path.join(home, 'Applications')]
  const apps: Array<{
    app: string
    bin: string
    name: string
    channel: FirefoxBinary['channel']
  }> = [
    { app: 'Firefox Developer Edition.app', bin: 'firefox', name: 'Firefox Developer Edition', channel: 'dev' },
    { app: 'Firefox Nightly.app', bin: 'firefox', name: 'Firefox Nightly', channel: 'nightly' },
    { app: 'Firefox.app', bin: 'firefox', name: 'Firefox', channel: 'firefox' },
    { app: 'Zen.app', bin: 'zen', name: 'Zen Browser', channel: 'zen' },
    { app: 'Zen Browser.app', bin: 'zen', name: 'Zen Browser', channel: 'zen' },
    { app: 'Waterfox.app', bin: 'waterfox', name: 'Waterfox', channel: 'waterfox' },
    { app: 'LibreWolf.app', bin: 'librewolf', name: 'LibreWolf', channel: 'librewolf' },
  ]
  const out: FirefoxBinary[] = []
  for (const app of apps) {
    for (const root of roots) {
      out.push({
        name: app.name,
        channel: app.channel,
        executablePath: path.join(root, app.app, 'Contents', 'MacOS', app.bin),
      })
    }
  }
  return out
}

function linuxBinaryCandidates(pathEnv: string): FirefoxBinary[] {
  const dirs = pathEnv.split(':').filter(Boolean)
  const bins: Array<{ bin: string; name: string; channel: FirefoxBinary['channel'] }> = [
    { bin: 'firefox-developer-edition', name: 'Firefox Developer Edition', channel: 'dev' },
    { bin: 'firefox-nightly', name: 'Firefox Nightly', channel: 'nightly' },
    { bin: 'firefox', name: 'Firefox', channel: 'firefox' },
    { bin: 'firefox-esr', name: 'Firefox ESR', channel: 'esr' },
    { bin: 'zen-browser', name: 'Zen Browser', channel: 'zen' },
    { bin: 'waterfox', name: 'Waterfox', channel: 'waterfox' },
    { bin: 'librewolf', name: 'LibreWolf', channel: 'librewolf' },
  ]
  const out: FirefoxBinary[] = []
  for (const entry of bins) {
    for (const dir of dirs) {
      out.push({ name: entry.name, channel: entry.channel, executablePath: path.join(dir, entry.bin) })
    }
  }
  return out
}

function windowsBinaryCandidates(env: Record<string, string | undefined>): FirefoxBinary[] {
  const bases = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((v): v is string => Boolean(v))
  const apps: Array<{ rel: string; name: string; channel: FirefoxBinary['channel'] }> = [
    { rel: 'Firefox Developer Edition\\firefox.exe', name: 'Firefox Developer Edition', channel: 'dev' },
    { rel: 'Firefox Nightly\\firefox.exe', name: 'Firefox Nightly', channel: 'nightly' },
    { rel: 'Mozilla Firefox\\firefox.exe', name: 'Firefox', channel: 'firefox' },
    { rel: 'Zen Browser\\zen.exe', name: 'Zen Browser', channel: 'zen' },
    { rel: 'Waterfox\\waterfox.exe', name: 'Waterfox', channel: 'waterfox' },
    { rel: 'LibreWolf\\librewolf.exe', name: 'LibreWolf', channel: 'librewolf' },
  ]
  const out: FirefoxBinary[] = []
  for (const app of apps) {
    for (const base of bases) {
      out.push({ name: app.name, channel: app.channel, executablePath: path.join(base, app.rel) })
    }
  }
  return out
}

export function discoverFirefoxBinaries(opts?: {
  platform?: NodeJS.Platform
  homedir?: string
  env?: Record<string, string | undefined>
  exists?: (p: string) => boolean
}): FirefoxBinary[] {
  const platform = opts?.platform ?? process.platform
  const home = opts?.homedir ?? homedir()
  const env = opts?.env ?? process.env
  const check = opts?.exists ?? existsSync

  const candidates =
    platform === 'darwin'
      ? macAppBinaryCandidates(home)
      : platform === 'win32'
        ? windowsBinaryCandidates(env)
        : linuxBinaryCandidates(env.PATH ?? '/usr/local/bin:/usr/bin:/bin')

  const found: FirefoxBinary[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate.executablePath)) continue
    if (check(candidate.executablePath)) {
      seen.add(candidate.executablePath)
      found.push(candidate)
    }
  }
  return found
}

export function resolveFirefoxBinary(
  query: string | undefined,
  discovered: FirefoxBinary[],
  opts?: { platform?: NodeJS.Platform; exists?: (p: string) => boolean },
): FirefoxBinary {
  const platform = opts?.platform ?? process.platform
  const check = opts?.exists ?? existsSync

  if (query) {
    const trimmed = query.trim()
    const alias = CHANNEL_ALIASES[trimmed.toLowerCase()]
    if (alias) {
      const match = discovered.find((b) => b.channel === alias)
      if (match) return match
      throw new Error(
        `--firefox "${trimmed}" was not found on this machine${discovered.length ? ` (found: ${discovered.map((b) => `${b.name} [${b.channel}]`).join(', ')})` : ''}`,
      )
    }

    // Allow passing a macOS .app bundle directly (e.g. /Applications/Firefox.app)
    if (platform === 'darwin' && trimmed.toLowerCase().endsWith('.app')) {
      for (const binName of ['firefox', 'zen', 'waterfox', 'librewolf']) {
        const inner = path.join(trimmed, 'Contents', 'MacOS', binName)
        if (check(inner)) {
          return { name: path.basename(trimmed, '.app'), channel: 'custom', executablePath: inner }
        }
      }
    }

    if (check(trimmed)) {
      return { name: path.basename(trimmed), channel: 'custom', executablePath: path.resolve(trimmed) }
    }

    throw new Error(
      `--firefox "${trimmed}" does not exist — pass a browser channel (firefox, dev, nightly, zen, waterfox, librewolf) or path to a Firefox executable`,
    )
  }

  if (discovered.length > 0) {
    return discovered[0]!
  }

  throw new Error(
    'no Firefox-based browser found on this machine — install Firefox (or Firefox Developer Edition / Nightly / Zen / Waterfox) or pass --firefox <path>',
  )
}

export async function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

export interface RdpAddonInstallResult {
  addonId: string
  backgroundScriptStatus?: string
  warnings: string[]
}

/**
 * Minimal, zero-dependency client for Firefox's Remote Debugging Protocol
 * (`--start-debugger-server <port>`). Installs an unpacked extension directory
 * as a temporary add-on and queries its live status and manifest warnings.
 */
export async function installTemporaryAddonViaRdp(
  port: number,
  addonPath: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number; host?: string },
): Promise<RdpAddonInstallResult> {
  const timeoutMs = options?.timeoutMs ?? 15_000
  const pollIntervalMs = options?.pollIntervalMs ?? 200
  const host = options?.host ?? '127.0.0.1'

  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const start = Date.now()
    const attempt = () => {
      const s = net.createConnection(port, host)
      s.once('connect', () => resolve(s))
      s.once('error', (err) => {
        s.destroy()
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`timed out connecting to Firefox debugger server on ${host}:${port}: ${err.message}`))
        } else {
          setTimeout(attempt, pollIntervalMs)
        }
      })
    }
    attempt()
  })

  try {
    let buf = Buffer.alloc(0)
    const responseQueue: Record<string, unknown>[] = []
    const waiters: Array<(msg: Record<string, unknown>) => void> = []

    const pushMessage = (msg: Record<string, unknown>) => {
      // Unsolicited server notifications include a `type` field; responses omit `type`.
      if (typeof msg.type === 'string') return
      const waiter = waiters.shift()
      if (waiter) waiter(msg)
      else responseQueue.push(msg)
    }

    sock.on('data', (chunk) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      buf = Buffer.concat([buf, bytes])
      while (true) {
        const colon = buf.indexOf(0x3a) // ':'
        if (colon === -1) break
        const lenStr = buf.subarray(0, colon).toString('ascii')
        const len = Number.parseInt(lenStr, 10)
        if (!Number.isFinite(len) || len < 0) break
        if (buf.length < colon + 1 + len) break
        const payload = buf.subarray(colon + 1, colon + 1 + len).toString('utf-8')
        buf = buf.subarray(colon + 1 + len)
        try {
          pushMessage(JSON.parse(payload) as Record<string, unknown>)
        } catch {
          // Ignore malformed packet
        }
      }
    })

    const nextResponse = (): Promise<Record<string, unknown>> => {
      if (responseQueue.length > 0) return Promise.resolve(responseQueue.shift()!)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Firefox RDP response timed out')), timeoutMs)
        waiters.push((msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
      })
    }

    const request = async (packet: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const json = JSON.stringify(packet)
      sock.write(`${Buffer.byteLength(json, 'utf-8')}:${json}`)
      return nextResponse()
    }

    // Consume initial hello packet
    await nextResponse()

    const root = await request({ to: 'root', type: 'getRoot' })
    const addonsActor = typeof root.addonsActor === 'string' ? root.addonsActor : undefined
    if (!addonsActor) {
      throw new Error('Firefox debugger server did not expose an addonsActor')
    }

    const installRes = await request({
      to: addonsActor,
      type: 'installTemporaryAddon',
      addonPath: path.resolve(addonPath),
      openDevTools: false,
    })

    if (installRes.error) {
      throw new Error(`Firefox rejected the temporary add-on: ${String(installRes.message ?? installRes.error)}`)
    }

    const installedId =
      installRes.addon && typeof installRes.addon === 'object'
        ? String((installRes.addon as Record<string, unknown>).id ?? '')
        : ''

    // Query live status + manifest warnings
    const listRes = await request({ to: 'root', type: 'listAddons' })
    const addons = Array.isArray(listRes.addons) ? (listRes.addons as Record<string, unknown>[]) : []
    const matched = addons.find((a) => a.id === installedId)
    const warnings = Array.isArray(matched?.warnings)
      ? matched.warnings.filter((w): w is string => typeof w === 'string')
      : []
    const backgroundScriptStatus =
      typeof matched?.backgroundScriptStatus === 'string' ? matched.backgroundScriptStatus : undefined

    return { addonId: installedId, backgroundScriptStatus, warnings }
  } finally {
    sock.destroy()
  }
}

export async function launchFirefoxWithExtension(opts: {
  binary: FirefoxBinary
  unpackedDir: string
  log: (msg: string) => void
  debug?: boolean
}): Promise<RdpAddonInstallResult> {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'extport-firefox-profile-'))
  const port = await findFreeLoopbackPort()

  const userJs = [
    'user_pref("devtools.debugger.remote-enabled", true);',
    'user_pref("devtools.debugger.prompt-connection", false);',
    'user_pref("devtools.chrome.enabled", true);',
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("extensions.autoDisableScopes", 10);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    '',
  ].join('\n')
  await writeFile(path.join(profileDir, 'user.js'), userJs, 'utf-8')

  opts.log(`── launching ${opts.binary.name} (${opts.binary.executablePath}) ──`)
  const child = spawn(
    opts.binary.executablePath,
    ['--no-remote', '-profile', profileDir, '--start-debugger-server', String(port)],
    {
      stdio: opts.debug ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'ignore', 'ignore'],
    },
  )

  const onSignal = () => {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    const installed = await installTemporaryAddonViaRdp(port, opts.unpackedDir)
    opts.log(
      `✅ Loaded "${installed.addonId}" in ${opts.binary.name}${installed.backgroundScriptStatus ? ` (background: ${installed.backgroundScriptStatus})` : ''}`,
    )
    for (const warning of installed.warnings) {
      opts.log(`⚠ Firefox: ${warning}`)
    }
    opts.log('Press Ctrl+C or close the browser window to exit (temporary profile will be cleaned up).')

    await new Promise<void>((resolve) => {
      child.once('close', () => resolve())
      child.once('error', () => resolve())
    })

    return installed
  } catch (err) {
    if (!child.killed) child.kill('SIGTERM')
    throw err
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await rm(profileDir, { recursive: true, force: true })
  }
}
