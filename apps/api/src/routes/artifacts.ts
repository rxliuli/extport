import { isValidExtensionVersion, newId, sha256Hex, STORES, type Store } from '@extport/shared'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { artifacts, extensions, publishTargets, type Extension } from '../db'
import { requireAuth, type AppEnv } from '../middleware/auth'
import { isVersionRegression, queueLatestArtifact } from '../reconcile/queue'
import { runReconciliation } from '../reconcile/run'

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

const route = new Hono<AppEnv>()

route.use('*', requireAuth)

function r2Key(tenantId: string, extensionId: string, version: string, store: Store | null): string {
  return `artifacts/${tenantId}/${extensionId}/${version}/${store ?? 'universal'}.zip`
}

async function resolveExtension(c: Context<AppEnv>, ref: string): Promise<Extension | null> {
  const tenant = c.get('tenant')
  const rows = await c
    .get('db')
    .select()
    .from(extensions)
    .where(
      and(
        eq(extensions.tenantId, tenant.id),
        or(eq(extensions.id, ref), eq(extensions.slug, ref)),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

route.post('/', async (c) => {
  const db = c.get('db')
  const tenant = c.get('tenant')
  const { extension: extensionRef, version, store: storeParam } = c.req.query()

  if (!extensionRef) return c.json({ error: 'extension query param is required (id or slug)' }, 400)
  if (!version || !isValidExtensionVersion(version)) {
    return c.json({ error: 'version must be 1-4 dot-separated integers (e.g. 1.2.3)' }, 400)
  }
  let store: Store | null = null
  if (storeParam) {
    if (!(STORES as readonly string[]).includes(storeParam)) {
      return c.json({ error: `store must be one of: ${STORES.join(', ')}` }, 400)
    }
    store = storeParam as Store
  }

  const extension = await resolveExtension(c, extensionRef)
  if (!extension) return c.json({ error: `extension "${extensionRef}" not found` }, 404)

  const declaredLength = Number(c.req.header('content-length') ?? '0')
  if (declaredLength > MAX_ARTIFACT_BYTES) return c.json({ error: 'artifact too large (max 64 MB)' }, 413)
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.length === 0) return c.json({ error: 'request body must be the zip file' }, 400)
  if (bytes.length > MAX_ARTIFACT_BYTES) return c.json({ error: 'artifact too large (max 64 MB)' }, 413)
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    return c.json({ error: 'body does not look like a zip file' }, 400)
  }

  const sha256 = await sha256Hex(bytes)

  // Versions are immutable: same bytes → idempotent success, different bytes → conflict.
  const [existing] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.extensionId, extension.id),
        eq(artifacts.version, version),
        store ? eq(artifacts.store, store) : isNull(artifacts.store),
      ),
    )
  if (existing) {
    if (existing.sha256 === sha256) return c.json({ artifact: existing, deduplicated: true })
    return c.json(
      { error: `version ${version} already exists with different content — bump the version`, existingSha256: existing.sha256 },
      409,
    )
  }

  // A genuinely new artifact — figure out which store(s) it's relevant to
  // (the one it was pushed for, or every currently-configured target if it's
  // a universal build) and refuse it outright if it would move any of them
  // backward. No silent "accepted but ignored" — a bad push should fail loudly.
  const targetStores = store
    ? [store]
    : (await db.select({ store: publishTargets.store }).from(publishTargets).where(eq(publishTargets.extensionId, extension.id))).map((t) => t.store)
  for (const s of targetStores) {
    if (await isVersionRegression(db, extension.id, s, version)) {
      return c.json({ error: `version ${version} is not newer than the version already queued/in review/live on ${s}` }, 409)
    }
  }

  const key = r2Key(tenant.id, extension.id, version, store)
  await c.env.ARTIFACTS.put(key, bytes, {
    httpMetadata: { contentType: 'application/zip' },
    customMetadata: { sha256, tenantId: tenant.id, extensionId: extension.id, version },
    sha256,
  })

  const id = newId('artifact')
  await db.insert(artifacts).values({
    id,
    tenantId: tenant.id,
    extensionId: extension.id,
    version,
    store,
    source: 'cli_upload',
    r2Key: key,
    sha256,
    size: bytes.length,
  })
  const [created] = await db.select().from(artifacts).where(eq(artifacts.id, id))

  for (const s of targetStores) {
    await queueLatestArtifact(db, tenant.id, extension.id, s)
  }
  if (targetStores.length > 0) {
    c.executionCtx.waitUntil(runReconciliation(c.env, db, { tenantId: tenant.id, extensionId: extension.id }))
  }

  return c.json({ artifact: created }, 201)
})

route.get('/', async (c) => {
  const ref = c.req.query('extension')
  if (!ref) return c.json({ error: 'extension query param is required' }, 400)
  const extension = await resolveExtension(c, ref)
  if (!extension) return c.json({ error: `extension "${ref}" not found` }, 404)
  const rows = await c
    .get('db')
    .select()
    .from(artifacts)
    .where(eq(artifacts.extensionId, extension.id))
    .orderBy(desc(artifacts.createdAt))
    .limit(50)
  return c.json({ artifacts: rows })
})

export default route
