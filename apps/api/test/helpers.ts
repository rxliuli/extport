import { newId } from '@extport/shared'
import { createExecutionContext, env } from 'cloudflare:test'
import { app } from '../src/index'
import { createDb, tenants, users } from '../src/db'
import { provisionTenantDek } from '../src/lib/kms'
import { SESSION_COOKIE, createSession } from '../src/lib/session'

export async function seedTenantWithUser() {
  const db = createDb(env.DB)
  const tenantId = newId('tenant')
  const userId = newId('user')
  const dek = await provisionTenantDek(env)
  await db.insert(tenants).values({
    id: tenantId,
    name: 'acme',
    email: 'dev@acme.test',
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

export function request(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.request(path, init, env, createExecutionContext()))
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
): Promise<{ id: string; slug: string }> {
  const res = await request('/api/v1/extensions', {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const body = (await res.json()) as { extension: { id: string; slug: string } }
  return body.extension
}

/** Smallest byte sequence our upload endpoint accepts as a zip. */
export function fakeZip(seed = 0): Uint8Array {
  const bytes = new Uint8Array(64)
  bytes[0] = 0x50
  bytes[1] = 0x4b
  bytes[2] = 0x03
  bytes[3] = 0x04
  bytes[4] = seed & 0xff
  return bytes
}
