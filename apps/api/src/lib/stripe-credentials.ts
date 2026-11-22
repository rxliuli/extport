import { decryptJson } from '@extport/shared'
import { and, eq } from 'drizzle-orm'
import { paymentCredentials, type Db, type PaymentCredential, type Tenant } from '../db'
import { tenantDek } from './kms'
import type { StripeAuth } from './stripe-api'

export interface StripeCredentialPayload {
  webhookSecret?: string
  apiKey?: string
}

export interface LoadedStripeCredential extends StripeCredentialPayload {
  row: PaymentCredential
  stripeAccountId?: string
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
    ...(row.stripeAccountId ? { stripeAccountId: row.stripeAccountId } : {}),
    ...(payload.webhookSecret ? { webhookSecret: payload.webhookSecret } : {}),
    ...(payload.apiKey ? { apiKey: payload.apiKey } : {}),
  }
}

/**
 * Resolves the Stripe API authentication for a tenant:
 * 1. Stripe Connect Standard OAuth (`stripeAccountId` + platform `STRIPE_SECRET_KEY`)
 * 2. Legacy manual Restricted Key (`apiKey`)
 */
export function resolveStripeAuth(env: Env, cred: LoadedStripeCredential | null): StripeAuth | null {
  if (cred?.stripeAccountId && env.STRIPE_SECRET_KEY?.trim()) {
    return {
      apiKey: env.STRIPE_SECRET_KEY.trim(),
      stripeAccountId: cred.stripeAccountId,
    }
  }
  if (cred?.apiKey) {
    return { apiKey: cred.apiKey }
  }
  return null
}
