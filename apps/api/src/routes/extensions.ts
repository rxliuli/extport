import { decryptJson, newId, PLAN_LIMITS, STORES, type Store } from '@extport/shared'
import { getAdapter } from '@extport/store-adapters'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { artifacts, deploymentVersions, extensions, licenses, plans, publishEvents, publishTargets, storeCredentials, type Db } from '../db'
import { tenantDek } from '../lib/kms'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireAuth, type AppEnv } from '../middleware/auth'
import { queueLatestArtifact } from '../reconcile/queue'
import { resolveTargetPlatforms, runReconciliation } from '../reconcile/run'
import { deriveTargetLifecycles } from '../reconcile/status'

const route = new Hono<AppEnv>()

route.use('*', requireAuth, requireActiveTenant)

const STORE_MSG = `store must be one of: ${STORES.join(', ')}`

route.get(
  '/',
  describeRoute({ summary: 'List extensions', responses: { 200: { description: 'OK' } } }),
  async (c) => {
    const rows = await c
      .get('db')
      .select()
      .from(extensions)
      .where(eq(extensions.tenantId, c.get('tenant').id))
      // Most-recently-touched first (updatedAt covers every tenant action:
      // creation, config edits, and artifact pushes — see artifacts.ts's
      // touch). Name as tiebreak keeps the order stable across refreshes.
      .orderBy(desc(extensions.updatedAt), extensions.name)
    return c.json({ extensions: rows })
  },
)

// Registered before /:id so the literal "matrix" segment isn't swallowed by the :id param.
route.get(
  '/matrix',
  describeRoute({
    summary: 'Publishing status matrix across all extensions',
    description: 'Every extension with its configured targets and their current lifecycle state, in one call.',
    responses: { 200: { description: 'OK' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')

    const extensionRows = await db
      .select()
      .from(extensions)
      .where(eq(extensions.tenantId, tenant.id))
      .orderBy(desc(extensions.updatedAt), extensions.name)

    const targetRows = await db
      .select({ target: publishTargets, credential: storeCredentials })
      .from(publishTargets)
      .innerJoin(storeCredentials, eq(publishTargets.credentialId, storeCredentials.id))
      .where(eq(publishTargets.tenantId, tenant.id))

    const extensionIds = [...new Set(targetRows.map((r) => r.target.extensionId))]
    const versionRows = extensionIds.length > 0 ? await db.select().from(deploymentVersions).where(inArray(deploymentVersions.extensionId, extensionIds)) : []
    const versionsByExtStore = new Map<string, typeof versionRows>()
    for (const v of versionRows) {
      const key = `${v.extensionId}:${v.store}`
      const list = versionsByExtStore.get(key)
      if (list) list.push(v)
      else versionsByExtStore.set(key, [v])
    }

    const targetsByExtension = new Map<string, unknown[]>()
    for (const row of targetRows) {
      const rows = versionsByExtStore.get(`${row.target.extensionId}:${row.target.store}`) ?? []
      const entry = {
        targetId: row.target.id,
        store: row.target.store,
        enabled: row.target.enabled,
        credentialLabel: row.credential.label,
        credentialStatus: row.credential.status,
        lifecycles: deriveTargetLifecycles(rows, row.target.lastErrorDetail),
        lastReconciledAt: row.target.lastReconciledAt,
      }
      const list = targetsByExtension.get(row.target.extensionId)
      if (list) list.push(entry)
      else targetsByExtension.set(row.target.extensionId, [entry])
    }

    return c.json({
      extensions: extensionRows.map((extension) => ({
        id: extension.id,
        name: extension.name,
        targets: targetsByExtension.get(extension.id) ?? [],
      })),
    })
  },
)

const createExtensionBodySchema = v.object({
  name: v.pipe(v.string('name is required'), v.trim(), v.minLength(1, 'name is required')),
})

route.post(
  '/',
  describeRoute({
    summary: 'Create an extension',
    description: 'name must be unique per tenant — it doubles as the licensing verification key.',
    responses: { 201: { description: 'Created' }, 403: { description: 'Plan limit reached' }, 409: { description: 'Slug already exists' } },
  }),
  validator('json', createExtensionBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')

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
      .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.name, body.name)))
    if (existing.length > 0) return c.json({ error: `an extension named "${body.name}" already exists` }, 409)

    const id = newId('extension')
    await db.insert(extensions).values({ id, tenantId: tenant.id, name: body.name })
    const [created] = await db.select().from(extensions).where(eq(extensions.id, id))
    return c.json({ extension: created }, 201)
  },
)

route.get(
  '/:id',
  describeRoute({ summary: 'Get an extension', responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const [extension] = await db
      .select()
      .from(extensions)
      .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, c.req.param('id'))))
    if (!extension) return c.json({ error: 'not found' }, 404)

    return c.json({ extension })
  },
)

const patchExtensionBodySchema = v.object({
  name: v.optional(v.string()),
  licensingEnabled: v.optional(v.boolean()),
})

route.patch(
  '/:id',
  describeRoute({
    summary: 'Update an extension',
    responses: { 200: { description: 'OK' }, 400: { description: 'Nothing to update' }, 404: { description: 'Not found' } },
  }),
  validator('json', patchExtensionBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const body = c.req.valid('json')
    const patch: Partial<typeof extensions.$inferInsert> = {}
    if (body.name?.trim()) patch.name = body.name.trim()
    if (typeof body.licensingEnabled === 'boolean') patch.licensingEnabled = body.licensingEnabled
    if (Object.keys(patch).length === 0) return c.json({ error: 'nothing to update' }, 400)

    // While licensing is enabled, the name is part of the verification
    // contract (the SDK's productName is cross-checked against it) —
    // renaming would fail every installed device's check. The freeze lifts
    // once the identity key moves to extensionId; see docs/licensing.md.
    if (patch.name !== undefined) {
      const [current] = await db
        .select({ name: extensions.name, licensingEnabled: extensions.licensingEnabled })
        .from(extensions)
        .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, c.req.param('id'))))
      if (!current) return c.json({ error: 'not found' }, 404)
      if (current.licensingEnabled && patch.name !== current.name) {
        return c.json({ error: 'name is locked while licensing is enabled — it is the productName your shipped extension verifies against' }, 409)
      }
    }

    const result = await db
      .update(extensions)
      .set(patch)
      .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, c.req.param('id'))))
    if (result.meta.changes === 0) return c.json({ error: 'not found' }, 404)
    const [updated] = await db.select().from(extensions).where(eq(extensions.id, c.req.param('id')))
    return c.json({ extension: updated })
  },
)

route.delete(
  '/:id',
  describeRoute({ summary: 'Delete an extension', description: 'Also deletes its artifacts, targets, versions, and events. Blocked while issued licenses exist.', responses: { 200: { description: 'OK' }, 404: { description: 'Not found' }, 409: { description: 'Issued licenses exist' } } }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const extension = await ownedExtension(db, tenant.id, c.req.param('id'))
    if (!extension) return c.json({ error: 'not found' }, 404)

    // Issued licenses are buyers' property — deleting the extension out from
    // under them would silently kill every activated device. Hard-block.
    const [licenseRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(licenses)
      .innerJoin(plans, eq(licenses.planId, plans.id))
      .where(eq(plans.extensionId, extension.id))
    if ((licenseRow?.count ?? 0) > 0) {
      return c.json({ error: 'licenses have been issued for this extension; it cannot be deleted' }, 409)
    }

    // No DB-level cascade (D1 doesn't enforce FKs) — clean up dependents ourselves,
    // R2 objects first since an orphaned artifact row can be re-derived from nothing.
    // r2Key is '' for a store that pins a version with no real file (Safari);
    // sourceR2Key is null when there's no companion source zip (everyone but
    // Firefox) — filter both sentinels out before asking R2 to delete anything.
    const artifactRows = await db.select({ r2Key: artifacts.r2Key, sourceR2Key: artifacts.sourceR2Key }).from(artifacts).where(eq(artifacts.extensionId, extension.id))
    const r2Keys = artifactRows.flatMap((a) => [a.r2Key, a.sourceR2Key]).filter((key): key is string => Boolean(key))
    if (r2Keys.length > 0) {
      await c.env.ARTIFACTS.delete(r2Keys)
    }

    await db.delete(publishEvents).where(eq(publishEvents.extensionId, extension.id))
    await db.delete(deploymentVersions).where(eq(deploymentVersions.extensionId, extension.id))
    await db.delete(artifacts).where(eq(artifacts.extensionId, extension.id))
    await db.delete(publishTargets).where(eq(publishTargets.extensionId, extension.id))
    await db.delete(plans).where(eq(plans.extensionId, extension.id)) // license-less by the guard above
    await db.delete(extensions).where(eq(extensions.id, extension.id))

    return c.json({ ok: true })
  },
)

route.post(
  '/:id/reconcile',
  describeRoute({ summary: 'Reconcile an extension now', description: 'Same logic the scheduled cron runs, triggered on demand.', responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const [extension] = await db
      .select({ id: extensions.id })
      .from(extensions)
      .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, c.req.param('id'))))
    if (!extension) return c.json({ error: 'not found' }, 404)

    const summary = await runReconciliation(c.env, db, { tenantId: tenant.id, extensionId: extension.id })
    return c.json({ summary })
  },
)

// The Timeline is deployment_versions (every push, and what happened to it)
// plus publish_events (error/stale_review — the two things that aren't about
// a specific version) merged by the caller; each has a different shape so
// they're returned as two arrays rather than forced into one.
route.get(
  '/:id/timeline',
  describeRoute({ summary: 'Get an extension\'s deployment timeline', responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const [extension] = await db
      .select({ id: extensions.id })
      .from(extensions)
      .where(and(eq(extensions.tenantId, tenant.id), eq(extensions.id, c.req.param('id'))))
    if (!extension) return c.json({ error: 'not found' }, 404)

    const [versions, events] = await Promise.all([
      db.select().from(deploymentVersions).where(eq(deploymentVersions.extensionId, extension.id)).orderBy(desc(deploymentVersions.createdAt)).limit(50),
      db.select().from(publishEvents).where(eq(publishEvents.extensionId, extension.id)).orderBy(desc(publishEvents.createdAt)).limit(50),
    ])
    return c.json({ versions, events })
  },
)

async function ownedExtension(db: Db, tenantId: string, extensionId: string) {
  const [extension] = await db
    .select({ id: extensions.id })
    .from(extensions)
    .where(and(eq(extensions.tenantId, tenantId), eq(extensions.id, extensionId)))
  return extension ?? null
}

route.get(
  '/:id/targets',
  describeRoute({ summary: 'List publish targets for an extension', responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const extension = await ownedExtension(db, tenant.id, c.req.param('id'))
    if (!extension) return c.json({ error: 'not found' }, 404)

    const rows = await db
      .select({ target: publishTargets, credential: storeCredentials })
      .from(publishTargets)
      .innerJoin(storeCredentials, eq(publishTargets.credentialId, storeCredentials.id))
      .where(eq(publishTargets.extensionId, extension.id))

    const versionRows = rows.length > 0 ? await db.select().from(deploymentVersions).where(eq(deploymentVersions.extensionId, extension.id)) : []
    const versionsByStore = new Map<Store, typeof versionRows>()
    for (const v of versionRows) {
      const list = versionsByStore.get(v.store)
      if (list) list.push(v)
      else versionsByStore.set(v.store, [v])
    }

    return c.json({
      targets: rows.map((r) => ({
        id: r.target.id,
        store: r.target.store,
        storeItemId: r.target.storeItemId,
        crxId: r.target.crxId,
        platforms: r.target.platforms,
        enabled: r.target.enabled,
        credentialId: r.credential.id,
        credentialLabel: r.credential.label,
        credentialStatus: r.credential.status,
        lifecycles: deriveTargetLifecycles(versionsByStore.get(r.target.store) ?? [], r.target.lastErrorDetail),
      })),
    })
  },
)

const addTargetBodySchema = v.object({
  store: v.picklist(STORES, STORE_MSG),
  storeItemId: v.pipe(v.string('storeItemId is required'), v.trim(), v.minLength(1, 'storeItemId is required')),
  // Edge only — see StoreTarget in @extport/store-adapters for why.
  crxId: v.optional(v.pipe(v.string(), v.trim())),
  // Safari only — narrows which of the adapter's platforms this target
  // actually has (e.g. ['macos'] for a macOS-only app). Omitted = every
  // platform the adapter declares; see publish_targets.platforms.
  platforms: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1)))),
  credentialId: v.pipe(v.string('credentialId is required'), v.minLength(1, 'credentialId is required')),
})

route.post(
  '/:id/targets',
  describeRoute({
    summary: 'Add a store target',
    description: "Verified against the live store API before saving — refuses a storeItemId the credential can't actually see.",
    responses: { 201: { description: 'Created' }, 404: { description: 'Not found' }, 409: { description: 'Already configured' } },
  }),
  validator('json', addTargetBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const extension = await ownedExtension(db, tenant.id, c.req.param('id'))
    if (!extension) return c.json({ error: 'not found' }, 404)

    const body = c.req.valid('json')
    const store = body.store
    const storeItemId = body.storeItemId
    const crxId = body.crxId || undefined

    const [credential] = await db
      .select()
      .from(storeCredentials)
      .where(and(eq(storeCredentials.tenantId, tenant.id), eq(storeCredentials.id, body.credentialId)))
    if (!credential) return c.json({ error: 'credential not found' }, 404)
    if (credential.store !== store) {
      return c.json({ error: `credential is for ${credential.store}, not ${store}` }, 400)
    }

    const existing = await db
      .select({ id: publishTargets.id })
      .from(publishTargets)
      .where(and(eq(publishTargets.extensionId, extension.id), eq(publishTargets.store, store)))
    if (existing.length > 0) return c.json({ error: `${store} is already configured for this extension` }, 409)

    const adapter = getAdapter(store)
    const platformsInput = body.platforms
    if (platformsInput) {
      if (!adapter.platforms) return c.json({ error: `${store} does not support per-platform configuration` }, 400)
      if (platformsInput.length === 0) return c.json({ error: 'platforms cannot be empty' }, 400)
      const invalid = platformsInput.filter((p) => !adapter.platforms!.includes(p))
      if (invalid.length > 0) return c.json({ error: `invalid platform(s) for ${store}: ${invalid.join(', ')}` }, 400)
    }

    // Verify storeItemId is real (and this credential can actually see it)
    // before creating anything — the same "check against the live store before
    // persisting" contract POST /v1/credentials already applies to the
    // credential itself. This also hands back real state, so the target
    // starts with an accurate baseline instead of "—" until a later reconcile.
    // Multi-platform stores (Safari) are queried once per platform — this is
    // also how platforms become "known" lifecycles: only platforms the store
    // actually reports something for get rows.
    const platforms = resolveTargetPlatforms({ platforms: platformsInput ?? null }, adapter)
    const observed: { platform: string | undefined; live?: string; inReview?: string }[] = []
    try {
      const dek = await tenantDek(c.env, tenant)
      const decrypted = await decryptJson(dek, credential.encryptedPayload)
      for (const platform of platforms) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- credentials are opaque per-store, validated at save time
        const actual = await adapter.getState(decrypted as any, { storeItemId, crxId }, platform)
        observed.push({
          platform,
          live: actual.live.known ? actual.live.version : undefined,
          inReview: actual.inReview.known ? actual.inReview.version : undefined,
        })
      }
    } catch (err) {
      return c.json({ error: `couldn't verify this item on ${store} — check the item id and credential`, detail: (err as Error).message }, 502)
    }

    const id = newId('publishTarget')
    await db.insert(publishTargets).values({
      id,
      tenantId: tenant.id,
      extensionId: extension.id,
      store,
      storeItemId,
      crxId,
      platforms: platformsInput ?? null,
      credentialId: credential.id,
      lastReconciledAt: new Date().toISOString(),
    })
    const [created] = await db.select().from(publishTargets).where(eq(publishTargets.id, id))

    // Record whatever the store just told us as the baseline. deployment_versions
    // is keyed by (extension, store), not by this target's id — a target that
    // was removed and re-added for the same store can leave history behind, so
    // this isn't necessarily a target's first-ever tick; skip anything already
    // recorded instead of assuming a clean slate.
    const existingRows = await db
      .select()
      .from(deploymentVersions)
      .where(and(eq(deploymentVersions.extensionId, extension.id), eq(deploymentVersions.store, store)))
    for (const { platform, live, inReview } of observed) {
      const dbPlatform = (platform ?? null) as (typeof existingRows)[number]['platform']
      const platformRows = existingRows.filter((v) => (v.platform ?? null) === (platform ?? null))
      if (live && !platformRows.some((v) => v.status === 'online' && v.version === live)) {
        await db.insert(deploymentVersions).values({
          id: newId('deploymentVersion'),
          tenantId: tenant.id,
          extensionId: extension.id,
          store,
          platform: dbPlatform,
          version: live,
          artifactId: null,
          status: 'online',
        })
      }
      if (inReview && !platformRows.some((v) => v.status === 'in_review' && v.version === inReview)) {
        await db.insert(deploymentVersions).values({
          id: newId('deploymentVersion'),
          tenantId: tenant.id,
          extensionId: extension.id,
          store,
          platform: dbPlatform,
          version: inReview,
          artifactId: null,
          status: 'in_review',
        })
      }
    }

    // Pick up anything already pushed before this target existed to receive
    // it, then reconcile in the background in case that's newer than what's
    // live/in-review above and can be submitted right away.
    await queueLatestArtifact(db, tenant.id, extension.id, store)
    c.executionCtx.waitUntil(runReconciliation(c.env, db, { tenantId: tenant.id, extensionId: extension.id }))

    return c.json({ target: created }, 201)
  },
)

const patchTargetBodySchema = v.object({
  storeItemId: v.optional(v.string()),
  crxId: v.optional(v.string()),
  credentialId: v.optional(v.string()),
  enabled: v.optional(v.boolean()),
  // Safari only — see addTargetBodySchema. null clears it back to every
  // platform the adapter declares.
  platforms: v.optional(v.nullable(v.array(v.pipe(v.string(), v.trim(), v.minLength(1))))),
})

route.patch(
  '/:id/targets/:targetId',
  describeRoute({
    summary: 'Update a publish target',
    responses: { 200: { description: 'OK' }, 400: { description: 'Nothing to update' }, 404: { description: 'Not found' } },
  }),
  validator('json', patchTargetBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const extension = await ownedExtension(db, tenant.id, c.req.param('id'))
    if (!extension) return c.json({ error: 'not found' }, 404)

    const [target] = await db
      .select()
      .from(publishTargets)
      .where(and(eq(publishTargets.id, c.req.param('targetId')), eq(publishTargets.extensionId, extension.id)))
    if (!target) return c.json({ error: 'not found' }, 404)

    const body = c.req.valid('json')
    const patch: Partial<typeof publishTargets.$inferInsert> = {}

    if (body.storeItemId?.trim()) patch.storeItemId = body.storeItemId.trim()
    // Edge only — see StoreTarget in @extport/store-adapters for why. Empty
    // string clears it back to falling through to storeItemId (pre-existing
    // targets' behavior), rather than being unable to unset it once set.
    if (body.crxId !== undefined) patch.crxId = body.crxId.trim() || null
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (body.platforms !== undefined) {
      if (body.platforms) {
        const adapter = getAdapter(target.store)
        if (!adapter.platforms) return c.json({ error: `${target.store} does not support per-platform configuration` }, 400)
        if (body.platforms.length === 0) return c.json({ error: 'platforms cannot be empty' }, 400)
        const invalid = body.platforms.filter((p) => !adapter.platforms!.includes(p))
        if (invalid.length > 0) return c.json({ error: `invalid platform(s) for ${target.store}: ${invalid.join(', ')}` }, 400)
      }
      patch.platforms = body.platforms
    }
    if (body.credentialId !== undefined) {
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
  },
)

route.delete(
  '/:id/targets/:targetId',
  describeRoute({ summary: 'Remove a publish target', responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } }),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const extension = await ownedExtension(db, tenant.id, c.req.param('id'))
    if (!extension) return c.json({ error: 'not found' }, 404)

    const result = await db
      .delete(publishTargets)
      .where(and(eq(publishTargets.id, c.req.param('targetId')), eq(publishTargets.extensionId, extension.id)))
    if (result.meta.changes === 0) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  },
)

export default route
