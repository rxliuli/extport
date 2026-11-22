import { and, eq } from 'drizzle-orm'
import { paymentCredentials, type Db, type PaymentCredential, type Tenant } from '../db'
import type { StripeAuth } from './stripe-api'

export interface LoadedStripeCredential {
  row: PaymentCredential
  stripeAccountId?: string
}

export async function loadStripeCredential(
  _env: Env,
  db: Db,
  tenant: Pick<Tenant, 'id'>,
): Promise<LoadedStripeCredential | null> {
  const [row] = await db
    .select()
    .from(paymentCredentials)
    .where(and(eq(paymentCredentials.tenantId, tenant.id), eq(paymentCredentials.provider, 'stripe')))
  if (!row) return null
  return {
    row,
    ...(row.stripeAccountId ? { stripeAccountId: row.stripeAccountId } : {}),
  }
}

/**
 * Resolves the Stripe API authentication for a tenant via Stripe Connect
 * Standard OAuth (`stripeAccountId` + platform `STRIPE_SECRET_KEY`).
 */
export function resolveStripeAuth(env: Env, cred: LoadedStripeCredential | null): StripeAuth | null {
  if (cred?.stripeAccountId && env.STRIPE_SECRET_KEY?.trim()) {
    return {
      apiKey: env.STRIPE_SECRET_KEY.trim(),
      stripeAccountId: cred.stripeAccountId,
    }
  }
  return null
}
