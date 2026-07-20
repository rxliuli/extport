import { newId, PLAN_LIMITS, STORES, type Store } from '@extport/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { artifacts, deploymentStates, extensions, products, publishEvents, publishTargets, storeCredentials, type Db } from '../db'
import { requireAuth, type AppEnv } from '../middleware/auth'
import { runReconciliation } from '../reconcile/run'

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

// Registered before /:id so the literal "matrix" segment isn't swallowed by the :id param.
route.get('/matrix', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')

  const extensionRows = await db
    .select()
    .from(extensions)
    .where(eq(extensions.tenantId, tenant.id))
    .orderBy(extensions.slug)

  const targetRows = await db
    .select({ target: publishTargets, credential: storeCredentials, deploymentState: deploymentStates })
    .from(publishTargets)
    .innerJoin(storeCredentials, eq(publishTargets.credentialId, storeCredentials.id))
    .leftJoin(
      deploymentStates,
      and(eq(deploymentStates.extensionId, publishTargets.extensionId), eq(deploymentStates.store, publishTargets.store)),
    )
    .where(eq(publishTargets.tenantId, tenant.id))

  const targetsByExtension = new Map<string, unknown[]>()
  for (const row of targetRows) {
    const entry = {
      targetId: row.target.id,
      store: row.target.store,
      enabled: row.target.enabled,
      credentialLabel: row.credential.label,
      credentialStatus: row.credential.status,
      status: row.deploymentState?.status ?? 'synced',
      liveVersion: row.deploymentState?.liveVersion ?? null,
      inReviewVersion: row.deploymentState?.inReviewVersion ?? null,
      statusDetail: row.deploymentState?.statusDetail ?? null,
      submittedAt: row.deploymentState?.submittedAt ?? null,
      lastReconciledAt: row.deploymentState?.lastReconciledAt ?? null,
    }
    const list = targetsByExtension.get(row.target.extensionId)
    if (list) list.push(entry)
    else targetsByExtension.set(row.target.extensionId, [entry])
  }

  return c.json({
    extensions: extensionRows.map((extension) => ({
      id: extension.id,
      name: extension.name,
      slug: extension.slug,
      publishingEnabled: extension.publishingEnabled,
      targets: targetsByExtension.get(extension.id) ?? [],
    })),
  })
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

route.delete('/:id', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const extension = await ownedExtension(db, tenant.id, c.req.param('id'))
  if (!extension) return c.json({ error: 'not found' }, 404)

  // No DB-level cascade (D1 doesn't enforce FKs) — clean up dependents ourselves,
  // R2 objects first since an orphaned artifact row can be re-derived from nothing.
  const artifactRows = await db.select({ r2Key: artifacts.r2Key }).from(artifacts).where(eq(artifacts.extensionId, extension.id))
  if (artifactRows.length > 0) {
    await c.env.ARTIFACTS.delete(artifactRows.map((a) => a.r2Key))
  }

  await db.delete(publishEvents).where(eq(publishEvents.extensionId, extension.id))
  await db.delete(deploymentStates).where(eq(deploymentStates.extensionId, extension.id))
  await db.delete(artifacts).where(eq(artifacts.extensionId, extension.id))
  await db.delete(publishTargets).where(eq(publishTargets.extensionId, extension.id))
  await db.delete(products).where(eq(products.extensionId, extension.id)) // Phase 2, always empty today
  await db.delete(extensions).where(eq(extensions.id, extension.id))

  return c.json({ ok: true })
})

route.post('/:id/reconcile', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const [extension] = await db
    .select({ id: extensions.id })
    .from(extensions)
    .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, c.req.param('id'))))
  if (!extension) return c.json({ error: 'not found' }, 404)

  const summary = await runReconciliation(c.env, db, { tenantId: tenant.id, extensionId: extension.id })
  return c.json({ summary })
})

route.get('/:id/events', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const [extension] = await db
    .select({ id: extensions.id })
    .from(extensions)
    .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, c.req.param('id'))))
  if (!extension) return c.json({ error: 'not found' }, 404)

  const events = await db
    .select()
    .from(publishEvents)
    .where(eq(publishEvents.extensionId, extension.id))
    .orderBy(desc(publishEvents.createdAt))
    .limit(50)
  return c.json({ events })
})

async function ownedExtension(db: Db, tenantId: string, extensionId: string) {
  const [extension] = await db
    .select({ id: extensions.id })
    .from(extensions)
    .where(and(eq(extensions.tenantId, tenantId), eq(extensions.id, extensionId)))
  return extension ?? null
}

route.get('/:id/targets', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const extension = await ownedExtension(db, tenant.id, c.req.param('id'))
  if (!extension) return c.json({ error: 'not found' }, 404)

  const rows = await db
    .select({ target: publishTargets, credential: storeCredentials })
    .from(publishTargets)
    .innerJoin(storeCredentials, eq(publishTargets.credentialId, storeCredentials.id))
    .where(eq(publishTargets.extensionId, extension.id))
  return c.json({
    targets: rows.map((r) => ({
      id: r.target.id,
      store: r.target.store,
      storeItemId: r.target.storeItemId,
      enabled: r.target.enabled,
      credentialId: r.credential.id,
      credentialLabel: r.credential.label,
      credentialStatus: r.credential.status,
    })),
  })
})

route.post('/:id/targets', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const extension = await ownedExtension(db, tenant.id, c.req.param('id'))
  if (!extension) return c.json({ error: 'not found' }, 404)

  const body = await c.req
    .json<{ store?: string; storeItemId?: string; credentialId?: string }>()
    .catch(() => ({}) as Record<string, never>)
  if (!body.store || !(STORES as readonly string[]).includes(body.store)) {
    return c.json({ error: `store must be one of: ${STORES.join(', ')}` }, 400)
  }
  const store = body.store as Store
  const storeItemId = body.storeItemId?.trim()
  if (!storeItemId) return c.json({ error: 'storeItemId is required' }, 400)
  if (!body.credentialId) return c.json({ error: 'credentialId is required' }, 400)

  const [credential] = await db
    .select({ id: storeCredentials.id, store: storeCredentials.store })
    .from(storeCredentials)
    .where(and(eq(storeCredentials.tenantId, tenant.id), eq(storeCredentials.id, body.credentialId)))
  if (!credential) return c.json({ error: 'credential not found' }, 404)
  if (credential.store !== store) {
    return c.json({ error: `credential is for ${credential.store}, not ${store}` }, 400)
  }

  const limit = PLAN_LIMITS[tenant.plan].maxStoresPerExtension
  if (limit !== null) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(publishTargets)
      .where(eq(publishTargets.extensionId, extension.id))
    if ((row?.count ?? 0) >= limit) {
      return c.json({ error: `plan limit reached (${limit} store${limit === 1 ? '' : 's'} per extension on ${tenant.plan})` }, 403)
    }
  }

  const existing = await db
    .select({ id: publishTargets.id })
    .from(publishTargets)
    .where(and(eq(publishTargets.extensionId, extension.id), eq(publishTargets.store, store)))
  if (existing.length > 0) return c.json({ error: `${store} is already configured for this extension` }, 409)

  const id = newId('publishTarget')
  await db.insert(publishTargets).values({
    id,
    tenantId: tenant.id,
    extensionId: extension.id,
    store,
    storeItemId,
    credentialId: credential.id,
  })
  const [created] = await db.select().from(publishTargets).where(eq(publishTargets.id, id))
  return c.json({ target: created }, 201)
})

route.patch('/:id/targets/:targetId', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const extension = await ownedExtension(db, tenant.id, c.req.param('id'))
  if (!extension) return c.json({ error: 'not found' }, 404)

  const [target] = await db
    .select()
    .from(publishTargets)
    .where(and(eq(publishTargets.id, c.req.param('targetId')), eq(publishTargets.extensionId, extension.id)))
  if (!target) return c.json({ error: 'not found' }, 404)

  type Patch = { storeItemId?: string; credentialId?: string; enabled?: boolean }
  const body = await c.req.json<Patch>().catch((): Patch => ({}))
  const patch: Partial<typeof publishTargets.$inferInsert> = {}

  if (typeof body.storeItemId === 'string' && body.storeItemId.trim()) patch.storeItemId = body.storeItemId.trim()
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.credentialId === 'string') {
    const [credential] = await db
      .select({ id: storeCredentials.id, store: storeCredentials.store })
      .from(storeCredentials)
      .where(and(eq(storeCredentials.tenantId, tenant.id), eq(storeCredentials.id, body.credentialId)))
    if (!credential) return c.json({ error: 'credential not found' }, 404)
    if (credential.store !== target.store) {
      return c.json({ error: `credential is for ${credential.store}, not ${target.store}` }, 400)
    }
    patch.credentialId = credential.id
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing to update' }, 400)

  await db.update(publishTargets).set(patch).where(eq(publishTargets.id, target.id))
  const [updated] = await db.select().from(publishTargets).where(eq(publishTargets.id, target.id))
  return c.json({ target: updated })
})

route.delete('/:id/targets/:targetId', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const extension = await ownedExtension(db, tenant.id, c.req.param('id'))
  if (!extension) return c.json({ error: 'not found' }, 404)

  const result = await db
    .delete(publishTargets)
    .where(and(eq(publishTargets.id, c.req.param('targetId')), eq(publishTargets.extensionId, extension.id)))
  if (result.meta.changes === 0) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

export default route
