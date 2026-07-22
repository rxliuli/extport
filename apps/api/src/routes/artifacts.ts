import { isValidExtensionVersion, newId, sha256Hex, STORES, type Store } from '@extport/shared'
import { getAdapter } from '@extport/store-adapters'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { artifacts, extensions, publishTargets, type Extension } from '../db'
import { requireAuth, type AppEnv } from '../middleware/auth'
import { isVersionRegression, queueLatestArtifact } from '../reconcile/queue'
import { runReconciliation } from '../reconcile/run'

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

const route = new Hono<AppEnv>()

route.use('*', requireAuth)

function r2Key(tenantId: string, extensionId: string, version: string, store: Store | null, suffix = ''): string {
  return `artifacts/${tenantId}/${extensionId}/${version}/${store ?? 'universal'}${suffix}.zip`
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
  if (declaredLength > MAX_ARTIFACT_BYTES * 2) return c.json({ error: 'artifact too large (max 64 MB)' }, 413)

  // Firefox can carry a companion source zip alongside the main one (AMO
  // requires source for bundled/minified submissions) — sent as multipart
  // with a "file" and optional "source" part. Every other push keeps the
  // plain "body IS the zip" shape unchanged.
  let bytes = new Uint8Array(0)
  let sourceBytes: Uint8Array | undefined
  const contentType = c.req.header('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    if (store !== 'firefox') return c.json({ error: 'a source zip is only accepted for --store firefox' }, 400)
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return c.json({ error: 'multipart body must include a "file" part with the zip' }, 400)
    bytes = new Uint8Array(await file.arrayBuffer())
    const source = form.get('source')
    if (source instanceof File && source.size > 0) sourceBytes = new Uint8Array(await source.arrayBuffer())
  } else {
    bytes = new Uint8Array(await c.req.arrayBuffer())
  }

  // Only a store whose adapter declares requiresArtifact: false (Safari) may
  // push with no file — its binary reaches the store directly, so this just
  // pins a version. Every other push (including a universal one, since some
  // targeted store always needs a real file) requires real content.
  const requiresArtifact = store ? (getAdapter(store).requiresArtifact ?? true) : true
  if (bytes.length === 0 && requiresArtifact) {
    return c.json({ error: 'request body must be the zip file' }, 400)
  }
  if (bytes.length > 0) {
    if (bytes.length > MAX_ARTIFACT_BYTES) return c.json({ error: 'artifact too large (max 64 MB)' }, 413)
    if (sourceBytes && sourceBytes.length > MAX_ARTIFACT_BYTES) return c.json({ error: 'source artifact too large (max 64 MB)' }, 413)
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      return c.json({ error: 'body does not look like a zip file' }, 400)
    }
  }

  // '' (not null) for a fileless push — r2_key/sha256 stay NOT NULL at the DB
  // level (see migration 0007's comment: relaxing that would need a table
  // recreation that hits a real FK constraint failure on D1's remote backend
  // once deployment_versions has real rows referencing this table).
  const sha256 = bytes.length > 0 ? await sha256Hex(bytes) : ''

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

  let key = ''
  let sourceKey: string | null = null
  if (bytes.length > 0) {
    key = r2Key(tenant.id, extension.id, version, store)
    await c.env.ARTIFACTS.put(key, bytes, {
      httpMetadata: { contentType: 'application/zip' },
      customMetadata: { sha256, tenantId: tenant.id, extensionId: extension.id, version },
      sha256,
    })
    if (sourceBytes) {
      sourceKey = r2Key(tenant.id, extension.id, version, store, '-source')
      await c.env.ARTIFACTS.put(sourceKey, sourceBytes, {
        httpMetadata: { contentType: 'application/zip' },
        customMetadata: { tenantId: tenant.id, extensionId: extension.id, version },
      })
    }
  }

  const id = newId('artifact')
  await db.insert(artifacts).values({
    id,
    tenantId: tenant.id,
    extensionId: extension.id,
    version,
    store,
    source: 'cli_upload',
    r2Key: key,
    sourceR2Key: sourceKey,
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
