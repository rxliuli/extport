import { newId } from '@extport/shared'
import { strToU8, zipSync } from 'fflate'
import { createExecutionContext, env } from 'cloudflare:test'
import { app } from '../src/index'
import { createDb, paymentCredentials, tenants, users, type Db } from '../src/db'
import { provisionTenantDek } from '../src/lib/kms'
import { SESSION_COOKIE, createSession } from '../src/lib/session'

export const TEST_STRIPE_SECRET_KEY = 'sk_test_platform_helper'
export const TEST_CONNECT_WEBHOOK_SECRET = 'whsec_testsecret123'

let stripeAcctSeq = 0

export async function connectStripeAccount(
  db: Db,
  tenantId: string,
  stripeAccountId = `acct_test_${++stripeAcctSeq}`,
): Promise<string> {
  await db.insert(paymentCredentials).values({
    id: newId('paymentCredential'),
    tenantId,
    provider: 'stripe',
    hint: '',
    apiKeyHint: null,
    stripeAccountId,
    encryptedPayload: '{}',
    keyVersion: 1,
  })
  return stripeAccountId
}

export async function seedTenantWithUser(opts: { status?: 'pending' | 'active' } = {}) {
  const db = createDb(env.DB)
  const tenantId = newId('tenant')
  const userId = newId('user')
  const dek = await provisionTenantDek(env)
  await db.insert(tenants).values({
    id: tenantId,
    name: 'acme',
    email: 'dev@acme.test',
    status: opts.status ?? 'active',
    dekEncrypted: dek.dekEncrypted,
    dekKeyVersion: dek.dekKeyVersion,
  })
  await db.insert(users).values({
    id: userId,
    tenantId,
    email: 'dev@acme.test',
    displayName: 'Acme Dev',
    authProvider: 'github',
    authSubject: newId('user'),
  })
  const session = await createSession(db, userId)
  return { db, tenantId, userId, sessionCookie: `${SESSION_COOKIE}=${session.token}` }
}

export function request(path: string, init?: RequestInit, customEnv?: Env): Promise<Response> {
  const baseEnv = env as Env
  const effectiveEnv: Env = customEnv ?? {
    ...baseEnv,
    STRIPE_SECRET_KEY: TEST_STRIPE_SECRET_KEY,
    STRIPE_CONNECT_WEBHOOK_SECRET: TEST_CONNECT_WEBHOOK_SECRET,
  }
  return Promise.resolve(app.request(path, init, effectiveEnv, createExecutionContext()))
}

export async function createApiKey(sessionCookie: string): Promise<string> {
  const res = await request('/api/v1/keys', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test' }),
  })
  const body = (await res.json()) as { key: string }
  return body.key
}

export async function createExtension(
  sessionCookie: string,
  name = 'My Extension',
): Promise<{ id: string; name: string }> {
  const res = await request('/api/v1/extensions', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const body = (await res.json()) as { extension: { id: string; name: string } }
  return body.extension
}

/**
 * A real zip carrying a manifest.json valid for every store (MV3, dual
 * background, gecko.id) — `version` must match the version being pushed,
 * `seed` varies the content. Deterministic: the mtime is pinned so identical
 * (seed, version) pairs hash identically, which the dedup tests rely on.
 */
export function fakeZip(seed = 0, version = '1.2.3', manifest?: object): Uint8Array {
  return zipSync(
    {
      'manifest.json': strToU8(
        JSON.stringify(
          manifest ?? {
            manifest_version: 3,
            name: 'Fake Extension',
            version,
            background: { service_worker: 'sw.js', scripts: ['bg.js'] },
            browser_specific_settings: { gecko: { id: 'fake@extport.test' } },
          },
        ),
      ),
      'seed.txt': strToU8(String(seed)),
    },
    { mtime: new Date('2020-01-01T00:00:00Z') },
  )
}
