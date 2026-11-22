import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiDir = path.resolve(__dirname, '../../api')
const persistDir = path.join(apiDir, '.wrangler-e2e')
const apiPort = process.env.E2E_API_PORT ?? '8790'
const dashboardPort = process.env.E2E_DASHBOARD_PORT ?? '5174'
const mockStripePort = process.env.MOCK_STRIPE_PORT ?? '8791'

// Start from a clean local D1 state every E2E run without touching the developer's .wrangler/state.
fs.rmSync(persistDir, { recursive: true, force: true })

execFileSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'extport', '--local', '--persist-to', persistDir],
  { cwd: apiDir, stdio: 'inherit' },
)

const child = spawn(
  'pnpm',
  [
    'exec',
    'wrangler',
    'dev',
    '--port',
    apiPort,
    '--ip',
    '127.0.0.1',
    '--persist-to',
    persistDir,
    '--var',
    'DEV_LOGIN_ENABLED:true',
    '--var',
    `DASHBOARD_URL:http://localhost:${dashboardPort}`,
    '--var',
    `PORTAL_URL:http://localhost:${dashboardPort}`,
    '--var',
    `STRIPE_API_BASE:http://127.0.0.1:${mockStripePort}/v1`,
    '--var',
    `STRIPE_CONNECT_OAUTH_BASE:http://127.0.0.1:${mockStripePort}`,
    '--var',
    'STRIPE_CONNECT_CLIENT_ID:ca_e2e_test',
    '--var',
    'STRIPE_SECRET_KEY:sk_test_e2e_platform',
    '--var',
    'STRIPE_CONNECT_WEBHOOK_SECRET:whsec_e2e_connect_secret_9876',
  ],
  { cwd: apiDir, stdio: 'inherit' },
)

const shutdown = (signal) => {
  child.kill(signal)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
child.on('exit', (code) => process.exit(code ?? 0))
