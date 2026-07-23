import { encryptJson, newId, randomBytes, STORES, toBase64, type Store } from '@extport/shared'
import { credentialHint } from '@extport/store-adapters'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { storeCredentials, tenants, users } from '../db'
import { provisionTenantDek, tenantDek } from '../lib/kms'
import { SESSION_COOKIE, createSession, destroySession } from '../lib/session'
import type { AppEnv } from '../middleware/auth'

const STATE_COOKIE = 'extport_oauth_state'
const RETURN_TO_COOKIE = 'extport_oauth_return_to'

// Same-origin only — never let this become an open redirect. Checked both
// before setting the cookie and again before redirecting to it, since a
// cookie's contents are one step further removed from "something we just
// validated" than a value used immediately in the same request.
function isSafeReturnTo(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')
}

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

  // Where the dashboard's own /login?returnTo=... wants to land back on
  // after this — GitHub's callback always returns to a fixed URL, so this
  // is what lets the tenant land back on (say) /cli-auth?port=... instead
  // of just the dashboard root every time.
  const returnTo = c.req.query('returnTo')
  if (returnTo && isSafeReturnTo(returnTo)) {
    setCookie(c, RETURN_TO_COOKIE, returnTo, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    })
  }

  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID)
  url.searchParams.set('redirect_uri', new URL('/api/auth/github/callback', c.req.url).toString())
  url.searchParams.set('scope', 'read:user user:email')
  url.searchParams.set('state', state)
  return c.redirect(url.toString())
})

auth.get('/github/callback', async (c) => {
  const { code, state } = c.req.query()
  const expectedState = getCookie(c, STATE_COOKIE)
  deleteCookie(c, STATE_COOKIE, { path: '/' })
  const returnTo = getCookie(c, RETURN_TO_COOKIE)
  deleteCookie(c, RETURN_TO_COOKIE, { path: '/' })
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
    expires: new Date(session.expiresAt),
  })
  const dest = returnTo && isSafeReturnTo(returnTo) ? new URL(returnTo, c.env.DASHBOARD_URL).toString() : c.env.DASHBOARD_URL
  return c.redirect(dest)
})

auth.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    await destroySession(c.get('db'), token)
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

// Well-formed enough for parseCredentials/credentialHint, never actually
// checked against a real store — only used to seed local-only test rows,
// never through the real POST /v1/credentials verify-before-save gate.
const FAKE_CREDENTIALS: Record<Store, Record<string, string>> = {
  chrome: { publisherId: 'dev-0000', clientEmail: 'dev@example.com', privateKey: 'fake' },
  firefox: { jwtIssuer: 'dev-issuer', jwtSecret: 'dev-secret' },
  edge: { clientId: 'dev-client', apiKey: 'dev-key-0000' },
  safari: { keyId: 'DEV0', issuerId: 'dev-issuer', privateKeyP8: 'fake' },
}

/**
 * Local dev only — mints a session directly, no GitHub OAuth round trip.
 * Gated on DEV_LOGIN_ENABLED, which only ever lives in .dev.vars (gitignored,
 * never part of what gets deployed) — absent in every real environment, so
 * this 404s there with no other guard needed.
 */
auth.get('/dev-login', async (c) => {
  if (!c.env.DEV_LOGIN_ENABLED) return c.notFound()

  const db = c.get('db')
  const authSubject = 'dev-local'
  const existing = await db
    .select()
    .from(users)
    .where(and(eq(users.authProvider, 'dev'), eq(users.authSubject, authSubject)))
    .limit(1)

  let userId: string
  if (existing[0]) {
    userId = existing[0].id
  } else {
    const tenantId = newId('tenant')
    userId = newId('user')
    const dek = await provisionTenantDek(c.env)
    await db.batch([
      db.insert(tenants).values({
        id: tenantId,
        name: 'Local Dev',
        email: 'dev@localhost',
        dekEncrypted: dek.dekEncrypted,
        dekKeyVersion: dek.dekKeyVersion,
      }),
      db.insert(users).values({
        id: userId,
        tenantId,
        email: 'dev@localhost',
        displayName: 'Local Dev',
        authProvider: 'dev',
        authSubject,
      }),
    ])

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId))
    const dekBytes = await tenantDek(c.env, tenant!)
    for (const store of STORES) {
      const credentials = FAKE_CREDENTIALS[store]
      await db.insert(storeCredentials).values({
        id: newId('storeCredential'),
        tenantId,
        store,
        label: store,
        hint: credentialHint(store, credentials as never),
        encryptedPayload: await encryptJson(dekBytes, credentials),
        keyVersion: tenant!.dekKeyVersion,
        status: 'active',
        lastVerifiedAt: new Date().toISOString(),
      })
    }
  }

  const session = await createSession(db, userId)
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    expires: new Date(session.expiresAt),
  })
  return c.redirect(c.env.DASHBOARD_URL)
})

export default auth
