import { generateApiKey, hashApiKey, maskApiKey, newId } from '@extport/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { apiKeys } from '../db'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireSession, type AppEnv } from '../middleware/auth'

const keys = new Hono<AppEnv>()

// API keys are managed from the dashboard only — an API key must not be able
// to mint or revoke other keys.
keys.use('*', requireSession, requireActiveTenant)

const keyRowSchema = v.object({
  id: v.string(),
  name: v.string(),
  masked: v.string(),
  createdAt: v.string(),
  lastUsedAt: v.nullable(v.string()),
})

keys.get(
  '/',
  describeRoute({
    summary: 'List API keys',
    description: 'Never returns the plaintext key or its hash — only a masked preview.',
    tags: ['API keys'],
    security: [{ session: [] }],
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: resolver(v.object({ keys: v.array(keyRowSchema) })) } } } },
  }),
  async (c) => {
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
  },
)

const createKeyBodySchema = v.object({
  name: v.pipe(v.string('name is required'), v.trim(), v.minLength(1, 'name is required')),
})

keys.post(
  '/',
  describeRoute({
    summary: 'Create an API key',
    description: 'The plaintext key is returned exactly once, here, and never persisted or shown again.',
    tags: ['API keys'],
    security: [{ session: [] }],
    responses: { 201: { description: 'Created', content: { 'application/json': { schema: resolver(v.object({ id: v.string(), name: v.string(), key: v.string(), masked: v.string() })) } } } },
  }),
  validator('json', createKeyBodySchema, badRequest),
  async (c) => {
    const { name } = c.req.valid('json')
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
  },
)

keys.delete(
  '/:id',
  describeRoute({
    summary: 'Revoke an API key',
    tags: ['API keys'],
    security: [{ session: [] }],
    responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const result = await db
      .update(apiKeys)
      .set({ revokedAt: new Date().toISOString() })
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
  },
)

export default keys
