import { del, get, set } from 'idb-keyval'

/**
 * @extport/sdk — license activation client for browser extensions, the
 * successor to @rxliuli/activation-client. The server is the only source of
 * truth (online activate / online check); this client caches the resulting
 * entitlement locally — no client-side cryptography. Wire contract and
 * design rationale: extport's docs/licensing.md.
 */

/**
 * The persisted shape of the activation config. Identical to what
 * @rxliuli/activation-client (and older hand-written fleet implementations)
 * wrote under the idb-keyval 'plan' key — the default storage adapter takes
 * over existing users' data in place, no migration. extport returns
 * expiresAt: null for perpetual licenses; far-future dates in old records
 * still parse as-is.
 */
export interface PlanConfig {
  code: string
  tier: string
  expiresAt: string | null
  fingerprint: string
}

export interface Plan<TTier extends string, TLimit> {
  tier: TTier
  limit: TLimit
}

export interface StorageAdapter {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  del(key: string): Promise<void>
}

/** The default idb-keyval store (keyval-store/keyval), matching where existing extensions already store it. */
export const idbStorage: StorageAdapter = { get, set, del }

/**
 * Transport for cross-context change notifications. The core doesn't care
 * about the implementation (the webext entry provides a runtime-message one);
 * it only broadcasts after a local change and refreshes on a remote change.
 */
export interface Transport {
  broadcast(): void
  listen(onRemoteChange: () => void): void
}

export interface ActivateResponse {
  success: boolean
  message: string
  data?: { tier: string; expiresAt: string | null }
}

interface CheckResponse {
  success: boolean
  data?: { isActive: boolean; tier: string | null; expiresAt: string | null }
}

export type PlanListener<TTier extends string, TLimit> = (plan: Plan<TTier, TLimit>, prev: Plan<TTier, TLimit>) => void

interface LicensingBackend {
  activateUrl: string
  checkUrl: string
}

function extportBackend(base: string): LicensingBackend {
  return {
    activateUrl: `${base}/api/v1/licensing/activate`,
    checkUrl: `${base}/api/v1/licensing/check`,
  }
}

const PRODUCTION_BACKEND = extportBackend('https://api.extport.dev')

/**
 * The global the @extport/wxt plugin injects before each entry's `main` (shared
 * with @extport/sdk/analytics — both always agree on one id, so there's no
 * "this context uses extensionId, that one uses productName" split). An explicit
 * argument wins; otherwise the injected global is read; with neither, the
 * caller decides how to fail (analytics skips silently, licensing throws at
 * construction — the difference lives at the call site, not here).
 */
export function resolveExtensionId(explicit?: string): string | undefined {
  if (explicit) return explicit
  const injected = (globalThis as { __EXTPORT__?: { extensionId?: string } }).__EXTPORT__
  return injected?.extensionId
}

export interface ActivationClientOptions<TTier extends string, TLimit> {
  /**
   * The extport extension id (ext_…). Optional: resolved automatically when
   * @extport/wxt injects it. If neither is available, it throws on the first
   * real network call (activate/checkActivation) — licensing failure must be
   * loud, never silently broken. **Not resolved/validated at construction**:
   * the WXT plugin injects globalThis.__EXTPORT__ after the top-level code of
   * the user's entry module evaluates (before main() runs), while
   * createActivationClient is usually constructed at that top level — throwing
   * then would happen before the injection and take down the whole service
   * worker's startup (not just licensing). getPlan() only reads local storage,
   * so it can be called right after construction.
   *
   * (The older productName + license-kit cascade was removed in 0.0.7; the
   * server retired productName after the fleet fully upgraded (2026-08) — the
   * wire only carries extensionId, old clients get a 400.)
   */
  extensionId?: string
  /** For local/self-hosted debugging: only requests that extport deployment. Omit = production api.extport.dev. */
  apiBase?: string
  /** The capability table per tier; must include 'free'. Unknown tiers found in storage are treated as free. */
  plans: Record<TTier, TLimit>
  storage?: StorageAdapter
  /** Storage key; defaults to 'plan' (matching existing extensions). */
  storageKey?: string
  transport?: Transport
  deviceInfo?: () => Record<string, unknown>
  /**
   * Re-evaluated on every getPlan(); a non-undefined return takes precedence
   * over the real activation record. Persists nothing — to "clear" the
   * override, just return undefined; no dedicated cleanup method. Typical use
   * is pinning a tier in local dev, but the library neither knows nor checks
   * whether the caller is really in a dev environment or whether the value
   * should sync across contexts — that's the caller's concern, handled in its
   * own hook via storage/messaging if desired.
   */
  override?: () => TTier | undefined | Promise<TTier | undefined>
}

export class ActivationClient<TTier extends string, TLimit> {
  private readonly options: ActivationClientOptions<TTier, TLimit>
  private readonly backend: LicensingBackend
  private readonly storage: StorageAdapter
  private readonly key: string
  private readonly freePlan: Plan<TTier, TLimit>
  private snapshot: Plan<TTier, TLimit>
  private loaded = false
  private listeners = new Set<PlanListener<TTier, TLimit>>()

  constructor(options: ActivationClientOptions<TTier, TLimit>) {
    const freeLimit = (options.plans as Record<string, TLimit>)['free']
    if (freeLimit === undefined) {
      throw new Error('plans must include a "free" tier')
    }
    this.options = options
    this.backend = options.apiBase ? extportBackend(options.apiBase) : PRODUCTION_BACKEND
    this.storage = options.storage ?? idbStorage
    this.key = options.storageKey ?? 'plan'
    this.freePlan = Object.freeze({ tier: 'free' as TTier, limit: freeLimit })
    this.snapshot = this.freePlan
    options.transport?.listen(() => {
      void this.getPlan().catch(() => {})
    })
  }

  /**
   * Synchronous snapshot of the current plan, for render layers like
   * useSyncExternalStore. Returns free until loaded; the reference stays
   * stable while the tier is unchanged. Business decisions (e.g. limit checks
   * mid-task) should use the live getPlan().
   */
  getSnapshot(): Plan<TTier, TLimit> {
    return this.snapshot
  }

  /**
   * Subscribe to changes to the effective tier. This context's own
   * activation/revocation and changes broadcast from other contexts via
   * transport share one channel; the first subscriber triggers an initial load.
   */
  subscribe(listener: PlanListener<TTier, TLimit>): () => void {
    this.listeners.add(listener)
    if (!this.loaded) {
      void this.getPlan().catch(() => {})
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Read and resolve the current plan fresh from storage. Always reflects
   * persisted state, no stale cache. If options.override() returns a valid
   * tier, it takes precedence over the real activation record — not persisted,
   * re-asked every time.
   */
  async getPlan(): Promise<Plan<TTier, TLimit>> {
    this.loaded = true
    const override = await this.resolveOverride()
    if (override) return this.commit(override)
    const config = await this.storage.get<PlanConfig>(this.key)
    return this.commit(this.resolve(config))
  }

  private async resolveOverride(): Promise<Plan<TTier, TLimit> | undefined> {
    const tier = await this.options.override?.()
    if (tier === undefined) return undefined
    if ((tier as string) === 'free') return this.freePlan
    const limit = (this.options.plans as Record<string, TLimit>)[tier as string]
    // The returned tier name isn't in the plans table: treat it as unset and
    // fall back to resolving the real activation record.
    return limit === undefined ? undefined : { tier, limit }
  }

  async activate(code: string): Promise<ActivateResponse> {
    const existing = await this.storage.get<PlanConfig>(this.key)
    const fingerprint = existing?.fingerprint ?? crypto.randomUUID()
    const r = await this.tryActivate(code, fingerprint)
    if (r.success && r.data) {
      await this.persist({ code, tier: r.data.tier, expiresAt: r.data.expiresAt ?? null, fingerprint })
    }
    return r
  }

  /**
   * Check with the server whether this device's activation is still valid.
   * Returns true = valid, false = invalidated (local state cleared),
   * undefined = no local activation record.
   *
   * When it reports "device not activated", it first reactivates using the
   * stored code+fingerprint (seat-decay self-healing); **local state is only
   * cleared on an explicit rejection (reactivation also rejected)** — network
   * failures or 5xx are expected transient states, always thrown, and errors
   * never trigger a clear.
   */
  async checkActivation(): Promise<boolean | undefined> {
    const config = await this.storage.get<PlanConfig>(this.key)
    if (!config) return undefined

    let active: boolean
    const result = await this.postJson<CheckResponse>(this.backend.checkUrl, {
      code: config.code,
      extensionId: this.resolveExtensionIdOrThrow(),
      fingerprint: config.fingerprint,
    })
    if (result.kind === 'rejected') {
      // An explicit rejection from the check endpoint (rare) — treat as
      // not activated and let the reactivation below handle it.
      active = false
    } else {
      if (!result.body.success || !result.body.data) throw new Error('Check device failed: no data')
      active = result.body.data.isActive
    }
    if (active) return true

    const reactivate = await this.tryActivate(config.code, config.fingerprint)
    if (reactivate.success && reactivate.data) {
      await this.persist({
        code: config.code,
        tier: reactivate.data.tier,
        expiresAt: reactivate.data.expiresAt ?? null,
        fingerprint: config.fingerprint,
      })
      return true
    }

    await this.storage.del(this.key)
    await this.getPlan()
    this.options.transport?.broadcast()
    return false
  }

  private async tryActivate(code: string, fingerprint: string): Promise<ActivateResponse> {
    const result = await this.postJson<ActivateResponse>(this.backend.activateUrl, {
      code,
      extensionId: this.resolveExtensionIdOrThrow(),
      fingerprint,
      deviceInfo: this.options.deviceInfo?.() ?? defaultDeviceInfo(),
    })
    if (result.kind === 'rejected') return { success: false, message: result.message }
    return result.body
  }

  /**
   * Deliberately read fresh before each network call, never cached or thrown at
   * construction — see the ActivationClientOptions.extensionId comment:
   * construction happens before the @extport/wxt plugin injection, so throwing
   * then would fail the whole entry module's evaluation.
   */
  private resolveExtensionIdOrThrow(): string {
    const extensionId = resolveExtensionId(this.options.extensionId)
    if (!extensionId) {
      throw new Error(
        'createActivationClient requires an extensionId — pass it explicitly, or use @extport/wxt (extport: { extension: "ext_…" }) so it can be injected automatically',
      )
    }
    return extensionId
  }

  /**
   * Distinguish three outcomes: 2xx = ok, 4xx with a parseable body = explicit
   * rejection, everything else (5xx/network) = transient failure, thrown — so
   * the caller can never mistake "server temporarily unreachable" for
   * "invalid code".
   */
  private async postJson<T>(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<{ kind: 'ok'; body: T } | { kind: 'rejected'; message: string }> {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (resp.ok) return { kind: 'ok', body: (await resp.json()) as T }
    if (resp.status >= 400 && resp.status < 500) {
      const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null
      if (body) {
        const message = [body['message'], body['error']].find((v) => typeof v === 'string') as string | undefined
        return { kind: 'rejected', message: message ?? 'rejected' }
      }
    }
    throw resp
  }

  private async persist(config: PlanConfig): Promise<void> {
    await this.storage.set(this.key, config)
    await this.getPlan()
    this.options.transport?.broadcast()
  }

  private resolve(config?: PlanConfig): Plan<TTier, TLimit> {
    if (!config) return this.freePlan
    if (config.expiresAt && new Date(config.expiresAt) < new Date()) return this.freePlan
    if (config.tier === 'free') return this.freePlan
    const limit = (this.options.plans as Record<string, TLimit>)[config.tier]
    if (limit === undefined) return this.freePlan
    return { tier: config.tier as TTier, limit }
  }

  private commit(plan: Plan<TTier, TLimit>): Plan<TTier, TLimit> {
    const prev = this.snapshot
    if (plan.tier === prev.tier) return prev
    this.snapshot = Object.freeze(plan)
    for (const listener of this.listeners) {
      listener(this.snapshot, prev)
    }
    return this.snapshot
  }
}

export function createActivationClient<TTier extends string, TLimit>(
  options: ActivationClientOptions<TTier, TLimit>,
): ActivationClient<TTier, TLimit> {
  return new ActivationClient(options)
}

function defaultDeviceInfo(): Record<string, unknown> {
  return typeof navigator !== 'undefined' ? { userAgent: navigator.userAgent } : {}
}
