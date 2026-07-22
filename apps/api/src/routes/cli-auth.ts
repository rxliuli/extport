import { generateApiKey, hashApiKey, newId, randomBytes, toBase64 } from '@extport/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { apiKeys, cliAuthExchanges } from '../db'
import { requireSession, type AppEnv } from '../middleware/auth'

const route = new Hono<AppEnv>()

const EXCHANGE_TTL_MS = 5 * 60 * 1000

function generateCode(): string {
  return toBase64(randomBytes(24)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * `extport login`'s loopback flow, step 1: the tenant is looking at this
 * from their own already-authenticated browser session (dashboard's
 * /cli-auth page), so this mints a real API key exactly like Settings → API
 * keys does, plus a short-lived one-time code standing in for it. Session
 * auth only, deliberately — an API key must never be able to mint another
 * API key for itself (same rule as /v1/keys).
 */
route.post('/start', requireSession, async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const generated = generateApiKey()
  await db.insert(apiKeys).values({
    id: newId('apiKey'),
    tenantId: tenant.id,
    name: 'CLI login',
    keyHash: await hashApiKey(generated.key),
    last4: generated.last4,
  })

  const code = generateCode()
  await db.insert(cliAuthExchanges).values({
    code,
    apiKey: generated.key,
    expiresAt: new Date(Date.now() + EXCHANGE_TTL_MS).toISOString(),
  })
  return c.json({ code })
})

/**
 * Step 2: the CLI's local callback server received this code from the
 * browser's redirect and exchanges it here for the real key — no auth,
 * deliberately, since the CLI has no session cookie; the code itself is the
 * credential, valid once, for minutes. The key never appears in a URL a
 * browser would keep in its history.
 */
route.post('/exchange', async (c) => {
  const db = c.get('db')
  const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string })
  const code = body.code
  if (!code) return c.json({ error: 'code is required' }, 400)

  const [row] = await db.select().from(cliAuthExchanges).where(eq(cliAuthExchanges.code, code))
  if (!row) return c.json({ error: 'invalid or already-used code' }, 400)
  await db.delete(cliAuthExchanges).where(eq(cliAuthExchanges.code, code))
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    return c.json({ error: 'code expired — run `extport login` again' }, 400)
  }
  return c.json({ key: row.apiKey })
})

export default route
