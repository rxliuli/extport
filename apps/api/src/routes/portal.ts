import { and, eq, gt, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { activations, extensions, licenses, magicLinks, plans } from '../db'
import {
  BUYER_SESSION_COOKIE,
  consumeMagicLink,
  createMagicLink,
  destroyBuyerSession,
  resolveBuyerSession,
} from '../lib/buyer-session'
import { sendMagicLinkEmail } from '../lib/licensing-email'
import { badRequest } from '../lib/validation'
import type { AppEnv } from '../middleware/auth'

// The buyer-facing surface (portal.extport.dev — read-only by design;
// seat release lives in the tenant dashboard, see docs/licensing.md):
// the checkout success page's time-boxed lookup, magic-link sign-in,
// and the signed-in purchase list.
const route = new Hono<AppEnv>()

// The Checkout Session id rides in the success page's URL — a bearer
// token for the code. High entropy plus this window keeps a leaked
// browser-history entry from mattering later; after expiry the page
// points at the email and the portal.
const PURCHASE_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000

// One magic-link email per address per minute — the endpoint must answer
// identically either way (no address enumeration), so throttling is
// silent too.
const MAGIC_LINK_THROTTLE_MS = 60 * 1000

route.get(
  '/purchase/:sessionId',
  describeRoute({
    summary: 'Look up a fulfilled purchase by Stripe Checkout Session id',
    description: 'Polled by the checkout success page. 404 until the webhook fulfills; 410 once the 24h window has passed.',
    responses: { 200: { description: 'Fulfilled' }, 404: { description: 'Not fulfilled (yet)' }, 410: { description: 'Window expired' } },
  }),
  async (c) => {
    const db = c.get('db')
    const [row] = await db
      .select({ license: licenses, plan: plans, extension: extensions })
      .from(licenses)
      .innerJoin(plans, eq(licenses.planId, plans.id))
      .innerJoin(extensions, eq(plans.extensionId, extensions.id))
      .where(eq(licenses.checkoutSessionId, c.req.param('sessionId')))
    if (!row) return c.json({ error: 'not found' }, 404)
    if (Date.now() - new Date(row.license.createdAt).getTime() > PURCHASE_LOOKUP_WINDOW_MS) {
      return c.json({ error: 'expired' }, 410)
    }
    return c.json({
      purchase: {
        key: row.license.key,
        productName: row.extension.name,
        tier: row.plan.tier,
        maxActivations: row.license.maxActivations,
        buyerEmail: row.license.buyerEmail,
        createdAt: row.license.createdAt,
      },
    })
  },
)

const requestLinkBodySchema = v.object({
  email: v.pipe(v.string('email is required'), v.trim(), v.email('email must be a valid email')),
})

route.post(
  '/request-link',
  describeRoute({
    summary: 'Request a portal sign-in link',
    description: 'Always responds ok — whether the address has purchases is never revealed here.',
    responses: { 200: { description: 'OK' } },
  }),
  validator('json', requestLinkBodySchema, badRequest),
  async (c) => {
    const db = c.get('db')
    const { email } = c.req.valid('json')

    const cutoff = new Date(Date.now() - MAGIC_LINK_THROTTLE_MS).toISOString()
    const [recent] = await db
      .select({ id: magicLinks.id })
      .from(magicLinks)
      .where(and(eq(magicLinks.email, email), gt(magicLinks.createdAt, cutoff)))
    if (!recent) {
      const link = await createMagicLink(db, email)
      const url = `${c.env.PORTAL_URL}/portal?code=${link.code}`
      await sendMagicLinkEmail(c.env, email, url)
    }
    return c.json({ ok: true })
  },
)

const verifyBodySchema = v.object({
  code: v.pipe(v.string('code is required'), v.trim(), v.minLength(1, 'code is required')),
})

route.post(
  '/verify',
  describeRoute({
    summary: 'Exchange a magic-link code for a buyer session',
    responses: { 200: { description: 'Signed in' }, 400: { description: 'Invalid, used, or expired' } },
  }),
  validator('json', verifyBodySchema, badRequest),
  async (c) => {
    const session = await consumeMagicLink(c.get('db'), c.req.valid('json').code)
    if (!session) return c.json({ error: 'link is invalid or has expired' }, 400)
    setCookie(c, BUYER_SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      expires: new Date(session.expiresAt),
    })
    return c.json({ email: session.email })
  },
)

async function signedInEmail(c: Context<AppEnv>): Promise<string | null> {
  const token = getCookie(c, BUYER_SESSION_COOKIE)
  if (!token) return null
  return resolveBuyerSession(c.get('db'), token)
}

route.get(
  '/licenses',
  describeRoute({
    summary: "List the signed-in buyer's licenses and devices",
    responses: { 200: { description: 'OK' }, 401: { description: 'No buyer session' } },
  }),
  async (c) => {
    const db = c.get('db')
    const email = await signedInEmail(c)
    if (!email) return c.json({ error: 'unauthorized' }, 401)

    // Across tenants on purpose: these are the buyer's own purchases,
    // wherever they were bought.
    const rows = await db
      .select({ license: licenses, plan: plans, extension: extensions })
      .from(licenses)
      .innerJoin(plans, eq(licenses.planId, plans.id))
      .innerJoin(extensions, eq(plans.extensionId, extensions.id))
      .where(eq(licenses.buyerEmail, email))
      .orderBy(licenses.createdAt)

    const licenseIds = rows.map((r) => r.license.id)
    const deviceRows = licenseIds.length
      ? await db.select().from(activations).where(inArray(activations.licenseId, licenseIds))
      : []
    const devicesByLicense = new Map<string, typeof deviceRows>()
    for (const device of deviceRows) {
      const list = devicesByLicense.get(device.licenseId)
      if (list) list.push(device)
      else devicesByLicense.set(device.licenseId, [device])
    }

    return c.json({
      email,
      licenses: rows.map(({ license, plan, extension }) => ({
        key: license.key,
        status: license.status,
        maxActivations: license.maxActivations,
        createdAt: license.createdAt,
        productName: extension.name,
        tier: plan.tier,
        devices: (devicesByLicense.get(license.id) ?? []).map((d) => ({
          fingerprint: d.deviceFingerprint,
          activatedAt: d.activatedAt,
          lastHeartbeatAt: d.lastHeartbeatAt,
          releasedAt: d.releasedAt,
        })),
      })),
    })
  },
)

route.post(
  '/logout',
  describeRoute({ summary: 'Sign out of the buyer portal', responses: { 200: { description: 'OK' } } }),
  async (c) => {
    const token = getCookie(c, BUYER_SESSION_COOKIE)
    if (token) await destroyBuyerSession(c.get('db'), token)
    deleteCookie(c, BUYER_SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  },
)

export default route
