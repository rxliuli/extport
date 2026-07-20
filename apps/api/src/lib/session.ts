import { newId, randomBytes, sha256Hex, toBase64 } from '@extport/shared'
import { and, eq, gt } from 'drizzle-orm'
import type { Db } from '../db'
import { sessions, users, type Tenant, type User } from '../db'
import { tenants } from '../db/schema'

export const SESSION_COOKIE = 'extport_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function createSession(
  db: Db,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = base64url(randomBytes(32))
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.insert(sessions).values({
    id: newId('session'),
    userId,
    tokenHash: await sha256Hex(token),
    expiresAt,
  })
  return { token, expiresAt }
}

export async function resolveSession(
  db: Db,
  token: string,
): Promise<{ user: User; tenant: Tenant } | null> {
  const tokenHash = await sha256Hex(token)
  const rows = await db
    .select({ user: users, tenant: tenants })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1)
  return rows[0] ?? null
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, await sha256Hex(token)))
}
