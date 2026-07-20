import { newId } from '@extport/shared'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb, storeCredentials, tenants } from '../src/db'
import { checkCredentialExpiry } from '../src/reconcile/expiry'
import { provisionTenantDek } from '../src/lib/kms'
import type { Notification, Notifier } from '../src/lib/notify'

function recordingNotifier(): { notifier: Notifier; sent: Notification[] } {
  const sent: Notification[] = []
  return { notifier: { send: (n) => Promise.resolve(void sent.push(n)) }, sent }
}

async function seedCredential(opts: {
  expiresAt: Date | null
  status: 'active' | 'invalid' | 'expiring'
  email?: string
}) {
  const db = createDb(env.DB)
  const tenantId = newId('tenant')
  const dek = await provisionTenantDek(env)
  await db.insert(tenants).values({
    id: tenantId,
    name: 't',
    email: opts.email ?? 'dev@example.com',
    dekEncrypted: dek.dekEncrypted,
    dekKeyVersion: dek.dekKeyVersion,
  })
  const credentialId = newId('storeCredential')
  await db.insert(storeCredentials).values({
    id: credentialId,
    tenantId,
    store: 'edge',
    label: 'my edge key',
    hint: '1234',
    encryptedPayload: 'v1.aaaa.bbbb',
    keyVersion: dek.dekKeyVersion,
    status: opts.status,
    expiresAt: opts.expiresAt,
  })
  return { db, tenantId, credentialId }
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

describe('checkCredentialExpiry', () => {
  it('flips active -> expiring and notifies once, inside the 30-day window', async () => {
    const { db, credentialId } = await seedCredential({ expiresAt: daysFromNow(10), status: 'active' })
    const { notifier, sent } = recordingNotifier()

    await checkCredentialExpiry(db, notifier)

    const [row] = await db.select().from(storeCredentials).where(eq(storeCredentials.id, credentialId))
    expect(row!.status).toBe('expiring')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'dev@example.com' })
    expect(sent[0]!.subject).toContain('my edge key')
    expect(sent[0]!.text).toContain('edge')
  })

  it('leaves credentials well outside the window untouched', async () => {
    const { db, credentialId } = await seedCredential({ expiresAt: daysFromNow(60), status: 'active' })
    const { notifier, sent } = recordingNotifier()

    await checkCredentialExpiry(db, notifier)

    const [row] = await db.select().from(storeCredentials).where(eq(storeCredentials.id, credentialId))
    expect(row!.status).toBe('active')
    expect(sent).toHaveLength(0)
  })

  it('does not re-notify a credential that is already expiring', async () => {
    const { db } = await seedCredential({ expiresAt: daysFromNow(5), status: 'expiring' })
    const { notifier, sent } = recordingNotifier()

    await checkCredentialExpiry(db, notifier)
    expect(sent).toHaveLength(0)
  })

  it('ignores credentials without expiresAt and already-invalid credentials', async () => {
    const a = await seedCredential({ expiresAt: null, status: 'active' })
    const b = await seedCredential({ expiresAt: daysFromNow(1), status: 'invalid' })
    const { notifier, sent } = recordingNotifier()

    await checkCredentialExpiry(a.db, notifier)
    await checkCredentialExpiry(b.db, notifier)
    expect(sent).toHaveLength(0)
  })
})
