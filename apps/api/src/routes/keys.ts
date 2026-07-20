import { generateApiKey, hashApiKey, maskApiKey, newId } from '@extport/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { apiKeys } from '../db'
import { requireSession, type AppEnv } from '../middleware/auth'

const keys = new Hono<AppEnv>()

// API keys are managed from the dashboard only — an API key must not be able
// to mint or revoke other keys.
keys.use('*', requireSession)

keys.get('/', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenant.id), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt))
  return c.json({
    keys: rows.map((k) => ({
      id: k.id,
      name: k.name,
      masked: maskApiKey(k.last4),
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    })),
  })
})

keys.post('/', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }))
  const name = body.name?.trim()
  if (!name) {
    return c.json({ error: 'name is required' }, 400)
  }
  const db = c.get('db')
  const tenant = c.get('tenant')
  const generated = generateApiKey()
  const id = newId('apiKey')
  await db.insert(apiKeys).values({
    id,
    tenantId: tenant.id,
    name,
    keyHash: await hashApiKey(generated.key),
    last4: generated.last4,
  })
  // The plaintext key is returned exactly once and never persisted.
  return c.json({ id, name, key: generated.key, masked: maskApiKey(generated.last4) }, 201)
})

keys.delete('/:id', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const result = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, c.req.param('id')),
        eq(apiKeys.tenantId, tenant.id),
        isNull(apiKeys.revokedAt),
      ),
    )
  if (result.meta.changes === 0) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.json({ ok: true })
})

export default keys
