import { hashApiKey, isApiKeyFormat } from '@extport/shared'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { createDb, apiKeys, tenants, type Db, type Tenant, type User } from '../db'
import { SESSION_COOKIE, resolveSession } from '../lib/session'

export interface AuthVariables {
  db: Db
  tenant: Tenant
  /** Present for session auth; null for API-key auth. */
  user: User | null
  authType: 'session' | 'api_key'
}

export type AppEnv = { Bindings: Env; Variables: AuthVariables }

/** Attaches a per-request Drizzle client. Runs before every route. */
export const withDb: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('db', createDb(c.env.DB))
  await next()
}

async function tryApiKey(c: Context<AppEnv>): Promise<boolean> {
  const header = c.req.header('authorization')
  if (!header?.startsWith('Bearer ')) return false
  const key = header.slice('Bearer '.length).trim()
  if (!isApiKeyFormat(key)) return false

  const db = c.get('db')
  const keyHash = await hashApiKey(key)
  const rows = await db
    .select({ apiKey: apiKeys, tenant: tenants })
    .from(apiKeys)
    .innerJoin(tenants, eq(apiKeys.tenantId, tenants.id))
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1)
  const row = rows[0]
  if (!row) return false

  c.set('tenant', row.tenant)
  c.set('user', null)
  c.set('authType', 'api_key')
  c.executionCtx.waitUntil(
    db.update(apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(apiKeys.id, row.apiKey.id)),
  )
  return true
}

async function trySession(c: Context<AppEnv>): Promise<boolean> {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return false
  const resolved = await resolveSession(c.get('db'), token)
  if (!resolved) return false
  c.set('tenant', resolved.tenant)
  c.set('user', resolved.user)
  c.set('authType', 'session')
  return true
}

/** Accepts either a dashboard session cookie or a tenant API key. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if ((await tryApiKey(c)) || (await trySession(c))) return next()
  return c.json({ error: 'unauthorized' }, 401)
}

/** Session-only routes (e.g. API key management must not be reachable with an API key). */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (await trySession(c)) return next()
  return c.json({ error: 'unauthorized' }, 401)
}
