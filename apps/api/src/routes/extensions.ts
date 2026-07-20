import { newId, PLAN_LIMITS } from '@extport/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { artifacts, extensions } from '../db'
import { requireAuth, type AppEnv } from '../middleware/auth'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

const route = new Hono<AppEnv>()

route.use('*', requireAuth)

route.get('/', async (c) => {
  const rows = await c
    .get('db')
    .select()
    .from(extensions)
    .where(eq(extensions.tenantId, c.get('tenant').id))
    .orderBy(extensions.slug)
  return c.json({ extensions: rows })
})

route.post('/', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const body = await c.req.json<{ name?: string; slug?: string }>().catch(() => ({}) as { name?: string; slug?: string })
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name is required' }, 400)
  const slug = body.slug?.trim() || slugify(name)
  if (!SLUG_RE.test(slug)) {
    return c.json({ error: 'slug must be lowercase alphanumeric with dashes' }, 400)
  }

  const limit = PLAN_LIMITS[tenant.plan].maxExtensions
  if (limit !== null) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(extensions)
      .where(eq(extensions.tenantId, tenant.id))
    if ((row?.count ?? 0) >= limit) {
      return c.json({ error: `plan limit reached (${limit} extension${limit === 1 ? '' : 's'} on ${tenant.plan})` }, 403)
    }
  }

  const existing = await db
    .select({ id: extensions.id })
    .from(extensions)
    .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.slug, slug)))
  if (existing.length > 0) return c.json({ error: `slug "${slug}" already exists` }, 409)

  const id = newId('extension')
  await db.insert(extensions).values({ id, tenantId: tenant.id, name, slug })
  const [created] = await db.select().from(extensions).where(eq(extensions.id, id))
  return c.json({ extension: created }, 201)
})

route.get('/:id', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const [extension] = await db
    .select()
    .from(extensions)
    .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, c.req.param('id'))))
  if (!extension) return c.json({ error: 'not found' }, 404)
  const recentArtifacts = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.extensionId, extension.id))
    .orderBy(desc(artifacts.createdAt))
    .limit(10)
  return c.json({ extension, artifacts: recentArtifacts })
})

route.patch('/:id', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  type Patch = { name?: string; publishingEnabled?: boolean; licensingEnabled?: boolean }
  const body = await c.req.json<Patch>().catch((): Patch => ({}))
  const patch: Partial<typeof extensions.$inferInsert> = {}
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim()
  if (typeof body.publishingEnabled === 'boolean') patch.publishingEnabled = body.publishingEnabled
  if (typeof body.licensingEnabled === 'boolean') patch.licensingEnabled = body.licensingEnabled
  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing to update' }, 400)

  const result = await db
    .update(extensions)
    .set(patch)
    .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, c.req.param('id'))))
  if (result.meta.changes === 0) return c.json({ error: 'not found' }, 404)
  const [updated] = await db.select().from(extensions).where(eq(extensions.id, c.req.param('id')))
  return c.json({ extension: updated })
})

export default route
