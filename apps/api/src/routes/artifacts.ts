import { isValidExtensionVersion, newId, parseZipManifest, sha256Hex, STORES, validateArtifactManifest, type Store } from '@extport/shared'
import { getAdapter } from '@extport/store-adapters'
import { and, desc, eq, isNull, ne, or } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { artifacts, extensions, publishTargets, tenants, type Db, type Extension, type PublishTarget } from '../db'
import { createEmailNotifier } from '../lib/notify'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireAuth, type AppEnv } from '../middleware/auth'
import { enqueueReconcile, isVersionRegression, queueLatestArtifact } from '../reconcile/queue'

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

const route = new Hono<AppEnv>()

route.use('*', requireAuth, requireActiveTenant)

function disabledTargetLine(t: PublishTarget): string {
  const since = t.disabledAt ? ` on ${t.disabledAt.slice(0, 10)}` : ''
  if (t.disabledSource === 'auto') {
    const why = t.disabledReason ? ` (${t.disabledReason})` : ''
    return `- ${t.store} — paused automatically${since}${why}. Fix the cause on the store's developer console, then re-enable the target; the newest version submits automatically.`
  }
  return `- ${t.store} — disabled manually${since}.`
}

/**
 * "You keep shipping while a store has quietly fallen behind" is a fact
 * only extport can see — the tenant's own disable (and forget), or an
 * auto-pause, silently exclude that store from every later release. Warn
 * once per version: pushes arrive as one request per store, so the gate is
 * "this version's first artifact", not "this push".
 */
async function warnAboutDisabledTargets(db: Db, env: Env, extension: Extension, version: string, newArtifactId: string): Promise<void> {
  const [sibling] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.extensionId, extension.id), eq(artifacts.version, version), ne(artifacts.id, newArtifactId)))
    .limit(1)
  if (sibling) return

  const disabled = await db
    .select()
    .from(publishTargets)
    .where(and(eq(publishTargets.extensionId, extension.id), eq(publishTargets.enabled, false)))
  if (disabled.length === 0) return

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, extension.tenantId))
  if (!tenant) return

  const stores = disabled.map((t) => t.store).join(', ')
  await createEmailNotifier(env).send({
    to: tenant.email,
    subject: `⚠️ ${extension.name} v${version} won't reach ${stores}`,
    text:
      `${extension.name} v${version} was pushed, but these store targets are disabled and will not receive it:\n\n` +
      disabled.map(disabledTargetLine).join('\n') +
      `\n\nManage targets: ${env.DASHBOARD_URL}/extensions/${extension.id}/publishing`,
  })
}

const EXTENSION_MSG = 'extension query param is required (the ext_… id)'
const VERSION_MSG = 'version must be 1-4 dot-separated integers (e.g. 1.2.3)'
const STORE_MSG = `store must be one of: ${STORES.join(', ')}`

const listQuerySchema = v.object({
  extension: v.pipe(v.string(EXTENSION_MSG), v.minLength(1, EXTENSION_MSG)),
})

const pushQuerySchema = v.object({
  extension: v.pipe(v.string(EXTENSION_MSG), v.minLength(1, EXTENSION_MSG)),
  version: v.pipe(v.string(VERSION_MSG), v.check(isValidExtensionVersion, VERSION_MSG)),
  store: v.optional(v.picklist(STORES, STORE_MSG)),
})

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
        eq(extensions.id, ref),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

route.post(
  '/',
  describeRoute({
    tags: ['Artifacts'],
    summary: 'Push an artifact',
    description:
      'Upload a zip (or, for stores whose adapter declares requiresArtifact: false, just pin a version already delivered out-of-band).',
    responses: {
      201: { description: 'Uploaded', content: { 'application/json': { schema: resolver(v.object({ artifact: v.any(), warning: v.optional(v.string()) })) } } },
      200: { description: 'Deduplicated — identical content already pushed', content: { 'application/json': { schema: resolver(v.object({ artifact: v.any(), deduplicated: v.literal(true) })) } } },
    },
  }),
  validator('query', pushQuerySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenant = c.get('tenant')
    const { extension: extensionRef, version, store: storeParam } = c.req.valid('query')
    const store = (storeParam ?? null) as Store | null

    const extension = await resolveExtension(c, extensionRef)
    if (!extension) return c.json({ error: `extension "${extensionRef}" not found` }, 404)

    // A store-specific push is accepted even with no publish_targets row yet —
    // queueLatestArtifact backfills it the moment one's added (see "Add a
    // store" in routes/extensions.ts) — but silently "succeeding" into a queue
    // nothing will ever drain is exactly the kind of surprise this project
    // otherwise refuses to let through quietly. A warning, not a rejection.
    let warning: string | undefined
    if (store) {
      const [target] = await db
        .select({ id: publishTargets.id })
        .from(publishTargets)
        .where(and(eq(publishTargets.extensionId, extension.id), eq(publishTargets.store, store)))
        .limit(1)
      if (!target) warning = `no publish target configured for store "${store}" yet — queued; it'll be picked up once one is added`
    }

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
      if (existing.sha256 === sha256) return c.json({ artifact: existing, deduplicated: true, warning })
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

    // The cheap version of what each target store's review pipeline would
    // reject hours or days later: no manifest.json, a version that isn't the
    // one being pushed, a Chrome-only build headed for Firefox. Runs after
    // the dedup check so re-pushes of pre-validation artifacts stay idempotent.
    if (bytes.length > 0 && store !== 'safari') {
      const problems = validateArtifactManifest(parseZipManifest(bytes), version, targetStores)
      if (problems.length > 0) return c.json({ error: problems.join('; ') }, 400)
    }

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
    // Pushing IS touching the extension — bump updatedAt so recency
    // ordering in the dashboard reflects publish activity, not just config
    // edits. Invariant: every future publish-shaped write path must do the
    // same, or its extensions stop floating to the top of the list.
    await db.update(extensions).set({ updatedAt: new Date().toISOString() }).where(eq(extensions.id, extension.id))
    c.executionCtx.waitUntil(warnAboutDisabledTargets(db, c.env, extension, version, id))
    const [created] = await db.select().from(artifacts).where(eq(artifacts.id, id))

    for (const s of targetStores) {
      await queueLatestArtifact(db, tenant.id, extension.id, s)
    }
    if (targetStores.length > 0) {
      await enqueueReconcile(c.env, { tenantId: tenant.id, extensionId: extension.id })
    }

    return c.json({ artifact: created, warning }, 201)
  },
)

route.get(
  '/',
  describeRoute({
    tags: ['Artifacts'],
    summary: 'List artifacts',
    description: 'The 50 most recent artifacts pushed for an extension.',
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: resolver(v.object({ artifacts: v.array(v.any()) })) } } },
    },
  }),
  validator('query', listQuerySchema, badRequest),
  async (c) => {
    const { extension: ref } = c.req.valid('query')
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
  },
)

export default route
