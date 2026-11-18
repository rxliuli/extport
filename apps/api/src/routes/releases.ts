import { and, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { announcedReleases, deploymentVersions, extensions, publishTargets } from '../db'
import { badRequest } from '../lib/validation'
import { requireActiveTenant, requireSession, type AppEnv } from '../middleware/auth'

// "What went live that I haven't announced yet" — the dashboard's release
// inbox. A release is one (extension, version) reaching its baseline store
// (see announcedReleases in db/schema.ts); everything here is derived from
// deployment_versions except the announced flag itself.

const route = new Hono<AppEnv>()

route.use('*', requireSession, requireActiveTenant)

/** Announced releases kept in the response, newest first, for context. */
const RECENT_ANNOUNCED = 15

/** D1 caps bound parameters at 100 per statement. */
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

route.get(
  '/',
  describeRoute({
    summary: 'List releases (live on their baseline store) and whether each was announced',
    tags: ['Releases'],
    security: [{ session: [] }],
    responses: { 200: { description: 'OK' } },
  }),
  async (c) => {
    const db = c.get('db')
    const tenantId = c.get('tenant').id

    const [online, chromeTargets, exts, announced] = await Promise.all([
      db
        .select()
        .from(deploymentVersions)
        .where(and(eq(deploymentVersions.tenantId, tenantId), eq(deploymentVersions.status, 'online'))),
      db
        .select({ extensionId: publishTargets.extensionId, storeItemId: publishTargets.storeItemId })
        .from(publishTargets)
        .where(and(eq(publishTargets.tenantId, tenantId), eq(publishTargets.store, 'chrome'))),
      db
        .select({ id: extensions.id, name: extensions.name })
        .from(extensions)
        .where(eq(extensions.tenantId, tenantId)),
      db.select().from(announcedReleases).where(eq(announcedReleases.tenantId, tenantId)),
    ])

    const chromeItem = new Map(chromeTargets.map((t) => [t.extensionId, t.storeItemId]))
    const extById = new Map(exts.map((e) => [e.id, e]))
    const announcedAt = new Map(announced.map((a) => [`${a.extensionId}\0${a.version}`, a.announcedAt]))

    // Baseline-store online rows, pushed through extport (artifactId set —
    // a null one is a baseline the reconciler observed, not a release).
    // An online row is never updated after its flip, so updatedAt is when
    // it went live.
    const releases = new Map<string, { extensionId: string; version: string; onlineAt: string }>()
    for (const row of online) {
      if (!row.artifactId || !extById.has(row.extensionId)) continue
      if (chromeItem.has(row.extensionId) && row.store !== 'chrome') continue
      const key = `${row.extensionId}\0${row.version}`
      const existing = releases.get(key)
      if (!existing || row.updatedAt < existing.onlineAt) {
        releases.set(key, { extensionId: row.extensionId, version: row.version, onlineAt: row.updatedAt })
      }
    }

    const sorted = [...releases.entries()].sort((a, b) => b[1].onlineAt.localeCompare(a[1].onlineAt))
    const pending = sorted.filter(([key]) => !announcedAt.has(key))
    const recent = sorted.filter(([key]) => announcedAt.has(key)).slice(0, RECENT_ANNOUNCED)
    const shown = [...pending, ...recent]

    // Every store's state for the shown versions — "Chrome live, Edge still
    // in review" is the context for whether to announce now.
    const versions = [...new Set(shown.map(([, r]) => r.version))]
    const storeRows = (
      await Promise.all(
        chunks(versions, 90).map((batch) =>
          db
            .select({
              extensionId: deploymentVersions.extensionId,
              version: deploymentVersions.version,
              store: deploymentVersions.store,
              platform: deploymentVersions.platform,
              status: deploymentVersions.status,
            })
            .from(deploymentVersions)
            .where(and(eq(deploymentVersions.tenantId, tenantId), inArray(deploymentVersions.version, batch))),
        ),
      )
    ).flat()

    return c.json({
      releases: shown.map(([key, r]) => {
        const ext = extById.get(r.extensionId)!
        const storeItemId = chromeItem.get(r.extensionId)
        return {
          extensionId: r.extensionId,
          extensionName: ext.name,
          version: r.version,
          onlineAt: r.onlineAt,
          announcedAt: announcedAt.get(key) ?? null,
          listingUrl: storeItemId ? `https://chromewebstore.google.com/detail/${storeItemId}` : null,
          stores: storeRows
            .filter((s) => s.extensionId === r.extensionId && s.version === r.version && s.status !== 'skipped')
            .map((s) => ({ store: s.store, platform: s.platform, status: s.status })),
        }
      }),
    })
  },
)

const markBodySchema = v.object({
  announced: v.boolean(),
  items: v.pipe(
    v.array(v.object({ extensionId: v.pipe(v.string(), v.minLength(1)), version: v.pipe(v.string(), v.minLength(1)) })),
    v.minLength(1),
    v.maxLength(200),
  ),
})

route.post(
  '/announced',
  describeRoute({
    summary: 'Mark releases as announced (or not)',
    tags: ['Releases'],
    security: [{ session: [] }],
    responses: { 200: { description: 'OK' } },
  }),
  validator('json', markBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const tenantId = c.get('tenant').id
    const { announced, items } = c.req.valid('json')

    // Only the tenant's own extensions — ids from the body are untrusted.
    const owned = await db.select({ id: extensions.id }).from(extensions).where(eq(extensions.tenantId, tenantId))
    const ownedIds = new Set(owned.map((e) => e.id))
    const valid = items.filter((i) => ownedIds.has(i.extensionId))

    for (const batch of chunks(valid, 30)) {
      if (announced) {
        await db
          .insert(announcedReleases)
          .values(batch.map((i) => ({ tenantId, extensionId: i.extensionId, version: i.version })))
          .onConflictDoNothing()
      } else {
        await db.delete(announcedReleases).where(
          and(
            eq(announcedReleases.tenantId, tenantId),
            sql`(${announcedReleases.extensionId}, ${announcedReleases.version}) IN (${sql.join(
              batch.map((i) => sql`(${i.extensionId}, ${i.version})`),
              sql`, `,
            )})`,
          ),
        )
      }
    }
    return c.json({ ok: true, updated: valid.length })
  },
)

export default route
