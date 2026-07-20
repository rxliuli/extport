import { newId, randomBytes, toBase64 } from '@extport/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { tenants, users } from '../db'
import { provisionTenantDek } from '../lib/kms'
import { SESSION_COOKIE, createSession, destroySession } from '../lib/session'
import type { AppEnv } from '../middleware/auth'

const STATE_COOKIE = 'extport_oauth_state'

interface GithubUser {
  id: number
  login: string
  name: string | null
  email: string | null
}

const auth = new Hono<AppEnv>()

auth.get('/github', (c) => {
  if (!c.env.GITHUB_CLIENT_ID) {
    return c.json({ error: 'GITHUB_CLIENT_ID is not configured' }, 500)
  }
  const state = toBase64(randomBytes(16)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  })
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID)
  url.searchParams.set('redirect_uri', new URL('/auth/github/callback', c.req.url).toString())
  url.searchParams.set('scope', 'read:user user:email')
  url.searchParams.set('state', state)
  return c.redirect(url.toString())
})

auth.get('/github/callback', async (c) => {
  const { code, state } = c.req.query()
  const expectedState = getCookie(c, STATE_COOKIE)
  deleteCookie(c, STATE_COOKIE, { path: '/' })
  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: 'invalid oauth state' }, 400)
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  })
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string }
  if (!tokenRes.ok || !tokenBody.access_token) {
    return c.json({ error: 'github token exchange failed', detail: tokenBody.error }, 502)
  }

  const ghHeaders = {
    authorization: `Bearer ${tokenBody.access_token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'extport',
  }
  const userRes = await fetch('https://api.github.com/user', { headers: ghHeaders })
  if (!userRes.ok) {
    return c.json({ error: 'failed to fetch github user' }, 502)
  }
  const ghUser = (await userRes.json()) as GithubUser

  let email = ghUser.email
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers: ghHeaders })
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email ?? null
    }
  }
  if (!email) {
    email = `${ghUser.id}+${ghUser.login}@users.noreply.github.com`
  }

  const db = c.get('db')
  const authSubject = String(ghUser.id)
  const existing = await db
    .select()
    .from(users)
    .where(and(eq(users.authProvider, 'github'), eq(users.authSubject, authSubject)))
    .limit(1)

  let userId: string
  if (existing[0]) {
    userId = existing[0].id
    await db
      .update(users)
      .set({ email, displayName: ghUser.name ?? ghUser.login })
      .where(eq(users.id, userId))
  } else {
    // First login: create a tenant with a freshly provisioned DEK, then the user.
    // Tenant zero (the author) goes through this exact same path.
    const tenantId = newId('tenant')
    userId = newId('user')
    const dek = await provisionTenantDek(c.env)
    await db.batch([
      db.insert(tenants).values({
        id: tenantId,
        name: ghUser.login,
        email,
        dekEncrypted: dek.dekEncrypted,
        dekKeyVersion: dek.dekKeyVersion,
      }),
      db.insert(users).values({
        id: userId,
        tenantId,
        email,
        displayName: ghUser.name ?? ghUser.login,
        authProvider: 'github',
        authSubject,
      }),
    ])
  }

  const session = await createSession(db, userId)
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    expires: session.expiresAt,
  })
  return c.redirect(c.env.DASHBOARD_URL)
})

auth.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    await destroySession(c.get('db'), token)
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

export default auth
