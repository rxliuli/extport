import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb, tenants, users } from '../src/db'
import { request } from './helpers'

function getCookieValue(setCookieHeader: string | null, name: string): string | undefined {
  if (!setCookieHeader) return undefined
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`))
  return match?.[1]
}

describe('GET /auth/github', () => {
  it('redirects to GitHub with the right client id and callback', async () => {
    const res = await request('/api/auth/github', { redirect: 'manual' })
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin).toBe('https://github.com')
    expect(location.searchParams.get('client_id')).toBe(env.GITHUB_CLIENT_ID)
    expect(location.searchParams.get('redirect_uri')).toContain('/api/auth/github/callback')
  })

  it('stashes a safe returnTo in a cookie', async () => {
    const res = await request('/api/auth/github?returnTo=%2Fcli-auth%3Fport%3D1234', { redirect: 'manual' })
    const returnTo = getCookieValue(res.headers.get('set-cookie'), 'extport_oauth_return_to')
    expect(decodeURIComponent(returnTo!)).toBe('/cli-auth?port=1234')
  })

  it('drops an unsafe (open-redirect) returnTo instead of cookie-ing it', async () => {
    for (const unsafe of ['https://evil.example.com', '//evil.example.com', '/\\evil.example.com']) {
      const res = await request(`/api/auth/github?returnTo=${encodeURIComponent(unsafe)}`, { redirect: 'manual' })
      expect(res.headers.get('set-cookie')).not.toContain('extport_oauth_return_to')
    }
  })
})

describe('GET /auth/github/callback', () => {
  const realFetch = globalThis.fetch

  function stubGithub(): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('access_token')) return new Response(JSON.stringify({ access_token: 'gh_token' }), { status: 200 })
      if (url.includes('/user/emails')) return new Response(JSON.stringify([]), { status: 200 })
      if (url.includes('/user')) return new Response(JSON.stringify({ id: 999, login: 'octocat', name: 'The Octocat', email: null }), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
  }

  // The state cookie's value and the `state` query param GitHub would echo
  // back are the same random token — /github sets one and puts the other in
  // the redirect URL it hands to GitHub, so reading either gives the value
  // the callback's cookie/query comparison needs to match.
  async function startLogin(returnTo?: string): Promise<{ state: string; returnToCookie?: string }> {
    const start = await request(`/api/auth/github${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`, { redirect: 'manual' })
    const setCookies = start.headers.getSetCookie?.() ?? [start.headers.get('set-cookie') ?? '']
    const returnToCookie = setCookies.map((c) => getCookieValue(c, 'extport_oauth_return_to')).find(Boolean)
    const location = new URL(start.headers.get('location')!)
    return { state: location.searchParams.get('state')!, returnToCookie }
  }

  it('redirects to the cookie-stashed returnTo after a successful login', async () => {
    stubGithub()
    try {
      const { state, returnToCookie } = await startLogin('/cli-auth?port=1234')
      const cookie = [`extport_oauth_state=${state}`, returnToCookie ? `extport_oauth_return_to=${returnToCookie}` : '']
        .filter(Boolean)
        .join('; ')

      const res = await request(`/api/auth/github/callback?code=abc&state=${state}`, {
        redirect: 'manual',
        headers: { cookie },
      })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(new URL('/cli-auth?port=1234', env.DASHBOARD_URL).toString())
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('creates a new tenant as pending', async () => {
    stubGithub()
    try {
      const { state } = await startLogin()
      const res = await request(`/api/auth/github/callback?code=abc&state=${state}`, {
        redirect: 'manual',
        headers: { cookie: `extport_oauth_state=${state}` },
      })
      expect(res.status).toBe(302)

      const db = createDb(env.DB)
      const [user] = await db.select().from(users).where(eq(users.authSubject, '999'))
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, user!.tenantId))
      expect(tenant!.status).toBe('pending')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('falls back to DASHBOARD_URL when there is no returnTo cookie', async () => {
    stubGithub()
    try {
      const { state } = await startLogin()
      const res = await request(`/api/auth/github/callback?code=abc&state=${state}`, {
        redirect: 'manual',
        headers: { cookie: `extport_oauth_state=${state}` },
      })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(env.DASHBOARD_URL)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
