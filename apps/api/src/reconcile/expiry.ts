import { and, eq, isNotNull } from 'drizzle-orm'
import { storeCredentials, tenants, type Db } from '../db'
import { statusFor } from '../lib/credential-status'
import type { Notifier } from '../lib/notify'

/**
 * One advance-warning email per credential, sent exactly once on the
 * active -> expiring transition (the WHERE clause only looks at credentials
 * still marked 'active', so this never re-fires every 30 minutes). This is a
 * deliberate simplification of spec §3.5's 30/7/1-day reminder ladder: a
 * single heads-up plus the natural 'error' notification once a credential
 * actually fails (wired through the main reconcile loop) covers the same
 * "before and after" need without a second state-tracking column.
 */
export async function checkCredentialExpiry(db: Db, notifier: Notifier): Promise<void> {
  const rows = await db
    .select({ credential: storeCredentials, tenant: tenants })
    .from(storeCredentials)
    .innerJoin(tenants, eq(storeCredentials.tenantId, tenants.id))
    .where(and(isNotNull(storeCredentials.expiresAt), eq(storeCredentials.status, 'active')))

  for (const { credential, tenant } of rows) {
    if (statusFor(true, credential.expiresAt) !== 'expiring') continue

    await db.update(storeCredentials).set({ status: 'expiring' }).where(eq(storeCredentials.id, credential.id))
    await notifier.send({
      to: tenant.email,
      subject: `🔑 "${credential.label}" (${credential.store}) expires soon`,
      text: `Your ${credential.store} credential "${credential.label}" expires on ${credential.expiresAt!.toISOString().slice(0, 10)}. Rotate it in Settings before then, or publishing to ${credential.store} will start failing.`,
    })
  }
}
