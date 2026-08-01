import { del, get, set } from 'idb-keyval'

/**
 * @extport/sdk — license activation client for browser extensions, the
 * successor to @rxliuli/activation-client. The server is the only source of
 * truth (online activate / online check); this client caches the resulting
 * entitlement locally — no client-side cryptography. Wire contract and
 * design rationale: extport's docs/licensing.md.
 */

/**
 * 激活配置的持久化格式。与 @rxliuli/activation-client（及更早的车队扩展
 * 手写实现）写入 idb-keyval 'plan' 键的记录完全一致——默认存储 adapter
 * 直接原位接管老用户数据,无需迁移。extport 对 perpetual 授权返回
 * expiresAt: null；历史记录里的远期日期照常解析。
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

/** idb-keyval 默认库（keyval-store/keyval）,与现有扩展的存储位置一致 */
export const idbStorage: StorageAdapter = { get, set, del }

/**
 * 跨上下文变更通知的传输层。core 不关心实现（webext 入口提供
 * runtime 消息实现）,只负责在本地变更后 broadcast、收到远端变更后刷新。
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
 * @extport/wxt 的 WXT 插件在每个入口 main 之前注入的全局(与
 * @extport/sdk/analytics 共用同一份解析——两边永远认同一个 id,
 * 不会出现"这个上下文用 extensionId、那个上下文用 productName"的分裂)。
 * 显式传参优先,否则读注入的全局;两者都没有则交给调用方决定失败姿态
 * (analytics 静默跳过,licensing 在构造时抛错——差异在调用点,不在这里)。
 */
export function resolveExtensionId(explicit?: string): string | undefined {
  if (explicit) return explicit
  const injected = (globalThis as { __EXTPORT__?: { extensionId?: string } }).__EXTPORT__
  return injected?.extensionId
}

export interface ActivationClientOptions<TTier extends string, TLimit> {
  /**
   * extport 扩展 id(ext_…)。可省略:@extport/wxt 注入时自动解析。两者都
   * 没有则构造时抛错——licensing 失效必须是响的,不能悄悄不工作。
   *
   * (旧版本的 productName + license-kit 级联已随本版本一起移除。
   * server 端仍临时接受 productName 以兼容尚未升级 SDK 的存量 build——
   * 那是已打包冻结的旧代码,不受这次改动影响。)
   */
  extensionId?: string
  /** 本地/自托管调试用:设置后只请求该 extport 部署。省略 = 生产 api.extport.dev。 */
  apiBase?: string
  /** 各档位的能力表,必须包含 'free'。存储中出现未知档位时按 free 处理 */
  plans: Record<TTier, TLimit>
  storage?: StorageAdapter
  /** 存储键,默认 'plan'（与现有扩展一致） */
  storageKey?: string
  transport?: Transport
  deviceInfo?: () => Record<string, unknown>
  /**
   * 每次 getPlan() 现读现问,返回值非 undefined 时优先于真实激活记录。不持久化任何状态——
   * 要"清除"覆盖,让它返回 undefined 就行,不需要专门的清理方法。典型用途是本地开发时
   * 想固定测某个档位,但库本身不关心也不校验调用方是不是真的在 dev 环境、要不要在多个
   * 上下文间同步这个值——那些是调用方自己的事,想要就自己在 hook 里接存储/消息。
   */
  override?: () => TTier | undefined | Promise<TTier | undefined>
}

export class ActivationClient<TTier extends string, TLimit> {
  private readonly options: ActivationClientOptions<TTier, TLimit>
  private readonly extensionId: string
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
    const extensionId = resolveExtensionId(options.extensionId)
    if (!extensionId) {
      throw new Error(
        'createActivationClient requires an extensionId — pass it explicitly, or use @extport/wxt (extport: { extension: "ext_…" }) so it can be injected automatically',
      )
    }
    this.extensionId = extensionId
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
   * 当前套餐的同步快照,供 useSyncExternalStore 等渲染层使用。
   * 未加载完成前返回 free；引用在档位不变时保持稳定。
   * 业务决策（如任务执行中的限额检查）应使用 getPlan() 现读。
   */
  getSnapshot(): Plan<TTier, TLimit> {
    return this.snapshot
  }

  /**
   * 订阅生效档位的变化。本上下文的激活/撤销与其他上下文经 transport
   * 广播来的变更走同一条通道；首个订阅者会触发一次初始加载。
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
   * 从存储现读并解析当前套餐。永远反映持久化状态,无陈旧缓存。
   * 若 options.override() 返回了有效档位,优先于真实激活记录——不持久化,每次都现问。
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
    // 返回的档位名字不在 plans 表里：当作没设置过,回落到真实激活记录解析
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
   * 向服务端校验本设备的激活状态。返回 true=有效,false=已失效
   * （本地状态已清除）,undefined=本地无激活记录。
   *
   * 说"设备未激活"时先拿存着的 code+fingerprint 自动重新激活一次（座位
   * 衰减回归自愈）；**只有明确拒绝(重激活也被拒)才清除本地状态**——网络
   * 故障或 5xx 是预期中的暂时状态,一律抛出,错误永远不触发清除。
   */
  async checkActivation(): Promise<boolean | undefined> {
    const config = await this.storage.get<PlanConfig>(this.key)
    if (!config) return undefined

    let active: boolean
    const result = await this.postJson<CheckResponse>(this.backend.checkUrl, {
      code: config.code,
      extensionId: this.extensionId,
      fingerprint: config.fingerprint,
    })
    if (result.kind === 'rejected') {
      // check 端点的明确拒绝(罕见)——按未激活处理,交给下面的重激活
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
      extensionId: this.extensionId,
      fingerprint,
      deviceInfo: this.options.deviceInfo?.() ?? defaultDeviceInfo(),
    })
    if (result.kind === 'rejected') return { success: false, message: result.message }
    return result.body
  }

  /**
   * 区分三种结果:2xx=ok、4xx 且 body 可解析=明确拒绝、其余(5xx/网络)=
   * 暂时故障,抛出——调用方永远不能把"服务器暂时不可达"当成"码无效"。
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
