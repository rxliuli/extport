import { fromBase64, generateDek, unwrapDek, wrapDek } from '@extport/shared'

/**
 * Master-key (KEK) management. KEKs live only in Workers secrets, named
 * KEK_V<n>; CURRENT_KEK_VERSION selects which one wraps new tenant DEKs.
 * Old versions stay configured until every tenant DEK is re-wrapped.
 */

export function getKek(env: Env, version: number): Uint8Array {
  const raw = (env as unknown as Record<string, unknown>)[`KEK_V${version}`]
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`KEK_V${version} secret is not configured`)
  }
  const bytes = fromBase64(raw)
  if (bytes.length !== 32) {
    throw new Error(`KEK_V${version} must decode to 32 bytes`)
  }
  return bytes
}

export function currentKekVersion(env: Env): number {
  const version = Number.parseInt(env.CURRENT_KEK_VERSION, 10)
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('CURRENT_KEK_VERSION must be a positive integer')
  }
  return version
}

/** Generate a fresh DEK for a new tenant, returning only the wrapped form. */
export async function provisionTenantDek(
  env: Env,
): Promise<{ dekEncrypted: string; dekKeyVersion: number }> {
  const version = currentKekVersion(env)
  const dekEncrypted = await wrapDek(getKek(env, version), generateDek())
  return { dekEncrypted, dekKeyVersion: version }
}

/** Recover a tenant's DEK. Callers must never log or persist the result. */
export function tenantDek(
  env: Env,
  tenant: { dekEncrypted: string; dekKeyVersion: number },
): Promise<Uint8Array> {
  return unwrapDek(getKek(env, tenant.dekKeyVersion), tenant.dekEncrypted)
}
