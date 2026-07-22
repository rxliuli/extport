import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'

export interface LoginResult {
  apiKey: string
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Self-contained on purpose — this is served by the CLI's own throwaway
// loopback server, not the dashboard, so it can't reach any of the
// dashboard's actual built assets. Colors are a hand-matched approximation
// of the dashboard's shadcn/ui dark theme, not a shared source of truth.
function callbackPage(opts: { ok: boolean; message: string }): string {
  const icon = opts.ok
    ? '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>'
    : '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>extport</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0a0a0a; color: #fafafa;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 360px; margin: 1.5rem; padding: 2rem;
    background: #111113; border: 1px solid #27272a; border-radius: 12px;
    text-align: center;
  }
  .wordmark { font-weight: 700; font-size: 0.95rem; letter-spacing: -0.01em; color: #a1a1aa; margin-bottom: 1.25rem; }
  .icon { margin-bottom: 1rem; }
  h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 0.4rem; }
  p { font-size: 0.875rem; color: #a1a1aa; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <div class="wordmark">extport</div>
    <div class="icon">${icon}</div>
    <h1>${opts.ok ? 'You’re logged in' : 'Login failed'}</h1>
    <p>${escapeHtml(opts.message)}</p>
  </div>
  <script>setTimeout(() => window.close(), 3000)</script>
</body>
</html>`
}

interface CallbackServer {
  port: number
  waitForCode: Promise<string>
}

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

/**
 * A one-shot local HTTP server that receives the browser's redirect after
 * the tenant approves CLI access on the dashboard — the same loopback
 * pattern `gh`/`wrangler` use for their own login flows. Only ever expects
 * one request, then shuts itself down.
 */
function startCallbackServer(timeoutMs: number): Promise<CallbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode!: (code: string) => void
    let rejectCode!: (err: Error) => void
    const waitForCode = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    let server: Server
    // clearTimeout happens at the settle site itself (not via a second
    // .catch()/.finally() consumer on waitForCode) — two independent
    // handlers attaching to the same promise on different microtask ticks
    // is exactly what trips Node's unhandled-rejection heuristic.
    const timeout = setTimeout(() => {
      server.close()
      settleReject(new Error(`timed out waiting for browser authorization (${Math.round(timeoutMs / 1000)}s)`))
    }, timeoutMs)
    const settleResolve = (code: string): void => {
      clearTimeout(timeout)
      resolveCode(code)
    }
    const settleReject = (err: Error): void => {
      clearTimeout(timeout)
      rejectCode(err)
    }

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        error
          ? callbackPage({ ok: false, message: `${error} — you can close this tab and try again from the terminal.` })
          : callbackPage({ ok: true, message: 'You can close this tab and return to the terminal.' }),
      )
      server.close()
      if (error) settleReject(new Error(error))
      else if (code) settleResolve(code)
      else settleReject(new Error('callback had no code'))
    })
    server.on('error', rejectServer)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        rejectServer(new Error('failed to determine callback server port'))
        return
      }
      resolveServer({ port: address.port, waitForCode })
    })
  })
}

function defaultOpenBrowser(url: string): void {
  const platform = process.platform
  if (platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
  else if (platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref()
  else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
}

export interface LoginDeps {
  openBrowser?: (url: string) => void
  log?: (msg: string) => void
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Opens the dashboard's CLI-authorize page, waits for it to redirect back
 * with a short-lived one-time code, then exchanges that code for a real API
 * key server-side — the code itself is never a usable credential and the
 * key never appears in a URL a browser would keep in its history.
 */
export async function login(apiUrl: string, deps: LoginDeps = {}): Promise<LoginResult> {
  const log = deps.log ?? console.log
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser
  const fetchImpl = deps.fetchImpl ?? fetch

  const { port, waitForCode } = await startCallbackServer(deps.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS)
  const authorizeUrl = new URL('/cli-auth', apiUrl)
  authorizeUrl.searchParams.set('port', String(port))

  log(`Opening ${authorizeUrl.toString()} …`)
  log("If your browser doesn't open automatically, visit that URL yourself.")
  openBrowser(authorizeUrl.toString())

  const code = await waitForCode

  const res = await fetchImpl(new URL('/api/v1/cli-auth/exchange', apiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) throw new Error(`login failed (${res.status}): ${await res.text()}`)
  const body = (await res.json()) as { key: string }
  return { apiKey: body.key }
}
