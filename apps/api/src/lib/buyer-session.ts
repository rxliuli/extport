import { newId, randomBytes, sha256Hex, toBase64 } from '@extport/shared'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { buyerSessions, magicLinks, type Db } from '../db'

// Buyer portal auth: magic link by email → buyer session. Same
// token-hashing discipline as tenant sessions (lib/session.ts); identity
// is just the email — licenses already carry buyerEmail.

export const BUYER_SESSION_COOKIE = 'extport_buyer_session'
export const BUYER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000

function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function createMagicLink(db: Db, email: string): Promise<{ code: string; expiresAt: string }> {
  const code = base64url(randomBytes(32))
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString()
  await db.insert(magicLinks).values({
    id: newId('magicLink'),
    email,
    codeHash: await sha256Hex(code),
    expiresAt,
  })
  return { code, expiresAt }
}

/** Single-use: consuming a valid link marks it used and mints a session. */
export async function consumeMagicLink(db: Db, code: string): Promise<{ email: string; token: string; expiresAt: string } | null> {
  const codeHash = await sha256Hex(code)
  const [link] = await db
    .select()
    .from(magicLinks)
    .where(and(eq(magicLinks.codeHash, codeHash), isNull(magicLinks.usedAt), gt(magicLinks.expiresAt, new Date().toISOString())))
  if (!link) return null
  await db.update(magicLinks).set({ usedAt: new Date().toISOString() }).where(eq(magicLinks.id, link.id))

  const token = base64url(randomBytes(32))
  const expiresAt = new Date(Date.now() + BUYER_SESSION_TTL_MS).toISOString()
  await db.insert(buyerSessions).values({
    id: newId('buyerSession'),
    email: link.email,
    tokenHash: await sha256Hex(token),
    expiresAt,
  })
  return { email: link.email, token, expiresAt }
}

export async function resolveBuyerSession(db: Db, token: string): Promise<string | null> {
  const tokenHash = await sha256Hex(token)
  const [session] = await db
    .select()
    .from(buyerSessions)
    .where(and(eq(buyerSessions.tokenHash, tokenHash), gt(buyerSessions.expiresAt, new Date().toISOString())))
  return session?.email ?? null
}

export async function destroyBuyerSession(db: Db, token: string): Promise<void> {
  await db.delete(buyerSessions).where(eq(buyerSessions.tokenHash, await sha256Hex(token)))
}
