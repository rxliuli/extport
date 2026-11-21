import { decryptJson } from '@extport/shared'
import { and, eq } from 'drizzle-orm'
import { paymentCredentials, type Db, type PaymentCredential, type Tenant } from '../db'
import { tenantDek } from './kms'

export interface StripeCredentialPayload {
  webhookSecret?: string
  apiKey?: string
}

export interface LoadedStripeCredential extends StripeCredentialPayload {
  row: PaymentCredential
}

export async function loadStripeCredential(
  env: Env,
  db: Db,
  tenant: Pick<Tenant, 'id' | 'dekEncrypted' | 'dekKeyVersion'>,
): Promise<LoadedStripeCredential | null> {
  const [row] = await db
    .select()
    .from(paymentCredentials)
    .where(and(eq(paymentCredentials.tenantId, tenant.id), eq(paymentCredentials.provider, 'stripe')))
  if (!row) return null
  const dek = await tenantDek(env, tenant)
  const payload = await decryptJson<StripeCredentialPayload>(dek, row.encryptedPayload)
  return {
    row,
    ...(payload.webhookSecret ? { webhookSecret: payload.webhookSecret } : {}),
    ...(payload.apiKey ? { apiKey: payload.apiKey } : {}),
  }
}
