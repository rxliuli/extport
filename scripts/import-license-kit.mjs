#!/usr/bin/env node
/**
 * One product at a time, license-kit → extport. Tenant-zero operational
 * tooling — reads license-kit's production D1, writes extport's, both via
 * the repos' own wrangler configs (no credentials handled here).
 *
 *   node scripts/import-license-kit.mjs --product "Substack Exporter"            # dry run
 *   node scripts/import-license-kit.mjs --product "Substack Exporter" --apply    # write
 *
 * Mapping (docs/licensing.md): code → licenses.key verbatim; maxDevices →
 * maxActivations; user.email → buyerEmail; payment.providerTransactionId →
 * sourceRef (refund continuity after the storefront webhook retires);
 * device → activations with lastSeenAt → lastHeartbeatAt. Timestamps are
 * preserved, source is 'imported'. Idempotent: codes already present in
 * extport are skipped, so re-runs only pick up what's new.
 *
 * The target plan must already exist (created in the dashboard) — this
 * script never invents catalog rows, matching the no-auto-created-plans
 * rule. It fails up front listing any missing (productName, tier) pair.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const LICENSE_KIT_DIR = resolve(ROOT, '../license-kit/packages/store')
const EXTPORT_API_DIR = join(ROOT, 'apps/api')
const TENANT_ID = 'ten_q1lfIFXR3AifwwdNdmEr'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const productIdx = args.indexOf('--product')
const productName = productIdx >= 0 ? args[productIdx + 1] : undefined
if (!productName) {
  console.error('usage: import-license-kit.mjs --product "Product Name" [--apply]')
  process.exit(1)
}

/** Same shape as @extport/shared's newId — 20 chars, base62. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
function newId(prefix) {
  // 62 doesn't divide 256 — reject bytes ≥ 248 to avoid modulo bias.
  const chars = []
  while (chars.length < 20) {
    for (const byte of randomBytes(32)) {
      if (byte < 248) chars.push(ALPHABET[byte % 62])
      if (chars.length === 20) break
    }
  }
  return `${prefix}_${chars.join('')}`
}

function d1(dir, database, sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  // wrangler prints non-JSON noise on some versions — take the JSON tail.
  const start = out.indexOf('[')
  return JSON.parse(out.slice(start))[0].results
}

const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replaceAll("'", "''")}'`)

// ---- read license-kit ----------------------------------------------------
const codes = d1(
  LICENSE_KIT_DIR,
  'store',
  `SELECT ac.id, ac.code, ac.plan_tier, ac.max_devices, ac.status, ac.expires_at, ac.created_at, ac.updated_at,
          u.email, p.provider, p.provider_transaction_id
   FROM activation_code ac
   JOIN user u ON ac.user_id = u.id
   LEFT JOIN payment p ON ac.payment_id = p.id
   WHERE ac.product_name = ${q(productName)}`,
)
if (codes.length === 0) {
  console.log(`license-kit has no activation codes for product ${JSON.stringify(productName)} — nothing to do`)
  process.exit(0)
}
const codeIds = codes.map((c) => q(c.id)).join(',')
const devices = d1(
  LICENSE_KIT_DIR,
  'store',
  `SELECT activation_code_id, fingerprint, device_info, last_seen_at, created_at, updated_at
   FROM device WHERE activation_code_id IN (${codeIds})`,
)

// ---- read extport (plans to resolve, existing rows for idempotency) ------
const tiers = [...new Set(codes.map((c) => c.plan_tier))]
const plans = d1(
  EXTPORT_API_DIR,
  'extport',
  `SELECT id, name, tier, max_activations FROM plans
   WHERE tenant_id = ${q(TENANT_ID)} AND name = ${q(productName)}`,
)
const planByTier = new Map(plans.map((p) => [p.tier, p]))
const missingTiers = tiers.filter((t) => !planByTier.has(t))
if (missingTiers.length > 0) {
  console.error(
    `extport has no plan for (${JSON.stringify(productName)}, ${missingTiers.join(', ')}) — ` +
      'create it in the dashboard first (plans are never auto-created).',
  )
  process.exit(1)
}
const existingKeys = new Set(
  d1(EXTPORT_API_DIR, 'extport', `SELECT key FROM licenses WHERE tenant_id = ${q(TENANT_ID)}`).map((r) => r.key),
)
const existingRefs = new Set(
  d1(EXTPORT_API_DIR, 'extport', `SELECT source_ref FROM licenses WHERE source_ref IS NOT NULL`).map(
    (r) => r.source_ref,
  ),
)

// ---- build the SQL -------------------------------------------------------
const STATUS_MAP = { active: 'active', revoked: 'refunded', expired: 'refunded' }
const statements = []
const skipped = []
let deviceCount = 0

for (const code of codes) {
  if (existingKeys.has(code.code)) {
    skipped.push(code.code)
    continue
  }
  const plan = planByTier.get(code.plan_tier)
  const licenseId = newId('lic')
  // Guard the global unique index: a ref already in extport (shouldn't
  // happen for legacy sales) must not blow up the whole batch.
  const sourceRef = code.provider_transaction_id && !existingRefs.has(code.provider_transaction_id)
    ? code.provider_transaction_id
    : null
  statements.push(
    `INSERT INTO licenses (id, tenant_id, plan_id, key, buyer_email, entitlement_type, max_activations, status, source, source_ref, checkout_session_id, created_at, updated_at)
     VALUES (${q(licenseId)}, ${q(TENANT_ID)}, ${q(plan.id)}, ${q(code.code)}, ${q(code.email)}, 'perpetual', ${code.max_devices}, ${q(STATUS_MAP[code.status] ?? 'refunded')}, 'imported', ${q(sourceRef)}, NULL, ${q(code.created_at)}, ${q(code.updated_at)});`,
  )
  for (const device of devices.filter((d) => d.activation_code_id === code.id)) {
    let uaHint = null
    try {
      const info = JSON.parse(device.device_info ?? 'null')
      if (info?.browser?.name) uaHint = `${info.browser.name} ${info.browser.version ?? ''} / ${info.os?.name ?? '?'}`.trim()
    } catch {}
    statements.push(
      `INSERT INTO activations (id, tenant_id, license_id, device_fingerprint, last_heartbeat_at, activated_at, released_at, ip_hint, ua_hint, created_at, updated_at)
       VALUES (${q(newId('act'))}, ${q(TENANT_ID)}, ${q(licenseId)}, ${q(device.fingerprint)}, ${q(device.last_seen_at ?? device.updated_at)}, ${q(device.created_at)}, NULL, NULL, ${q(uaHint)}, ${q(device.created_at)}, ${q(device.updated_at)});`,
    )
    deviceCount++
  }
  statements.push(
    `INSERT INTO license_events (id, tenant_id, license_id, type, payload, created_at)
     VALUES (${q(newId('lev'))}, ${q(TENANT_ID)}, ${q(licenseId)}, 'issued', '{"source":"imported","from":"license-kit"}', ${q(code.created_at)});`,
  )
}

// ---- report / apply ------------------------------------------------------
console.log(`product:        ${productName}`)
console.log(`codes found:    ${codes.length} (tiers: ${tiers.join(', ')})`)
console.log(`already there:  ${skipped.length}${skipped.length ? ` (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', …' : ''})` : ''}`)
console.log(`to import:      ${codes.length - skipped.length} licenses, ${deviceCount} activations`)

if (statements.length === 0) {
  console.log('nothing to import — already in sync')
  process.exit(0)
}

const sample = codes.find((c) => !existingKeys.has(c.code))
console.log(`sample:         ${sample.code} (${sample.plan_tier}, ${sample.email}, status ${sample.status}, ref ${sample.provider_transaction_id ?? '—'})`)

if (!apply) {
  console.log('\ndry run — re-run with --apply to write these rows into extport production')
  process.exit(0)
}

const file = join(mkdtempSync(join(tmpdir(), 'lk-import-')), 'import.sql')
writeFileSync(file, statements.join('\n'))
console.log(`\napplying ${statements.length} statements…`)
execFileSync('npx', ['wrangler', 'd1', 'execute', 'extport', '--remote', '-y', '--file', file], {
  cwd: EXTPORT_API_DIR,
  stdio: 'inherit',
})
console.log('done — verify with a spot-check: activate/check one imported code against the public endpoint')
