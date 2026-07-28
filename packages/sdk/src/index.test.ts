import 'fake-indexeddb/auto'
import { clear, get as idbGet, set as idbSet } from 'idb-keyval'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActivationClient, type ActivationClientOptions, type PlanConfig } from './index'

const FREE_LIMIT = { records: 100 }
const PRO_LIMIT = { records: Number.MAX_SAFE_INTEGER }

type Tier = 'free' | 'pro'
type Limit = typeof FREE_LIMIT

function createClient(overrides: Partial<ActivationClientOptions<Tier, Limit>> = {}) {
  return createActivationClient<Tier, Limit>({
    productName: 'My Product',
    apiBase: 'https://dash.example.com',
    plans: { free: FREE_LIMIT, pro: PRO_LIMIT },
    ...overrides,
  })
}

function future(): string {
  return new Date(Date.now() + 24 * 3600_000).toISOString()
}

function past(): string {
  return new Date(Date.now() - 24 * 3600_000).toISOString()
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function storedConfig(overrides: Partial<PlanConfig> = {}): PlanConfig {
  return {
    code: 'AAAA-BBBB-CCCC-DDDD',
    tier: 'pro',
    expiresAt: null,
    fingerprint: 'fp-stored',
    ...overrides,
  }
}

/** Routes extport/legacy check+activate to the given handlers; anything else fails the test. */
function stubWire(handlers: {
  check?: (body: Record<string, unknown>) => Response
  activate?: (body: Record<string, unknown>) => Response
  legacyCheck?: (body: Record<string, unknown>) => Response
  legacyActivate?: (body: Record<string, unknown>) => Response
}) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as Record<string, unknown>
    calls.push({ url, body })
    if (url === 'https://store.rxliuli.com/api/activation/check' && handlers.legacyCheck) return handlers.legacyCheck(body)
    if (url === 'https://store.rxliuli.com/api/activation/activate' && handlers.legacyActivate) return handlers.legacyActivate(body)
    if (url.endsWith('/api/v1/licensing/check') && handlers.check) return handlers.check(body)
    if (url.endsWith('/api/v1/licensing/activate') && handlers.activate) return handlers.activate(body)
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

const CHECK_ACTIVE = () => jsonResponse({ success: true, data: { isActive: true, tier: 'pro', expiresAt: null } })
const CHECK_INACTIVE = () => jsonResponse({ success: true, data: { isActive: false, tier: 'pro', expiresAt: null } })
const ACTIVATE_OK = () => jsonResponse({ success: true, message: 'activated', data: { tier: 'pro', expiresAt: null } })
const ACTIVATE_REJECTED = () => jsonResponse({ success: false, message: 'invalid activation code' })

beforeEach(async () => {
  await clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('契约：兼容 activation-client 时代的历史数据', () => {
  it('原样读取旧客户端写入 idb-keyval "plan" 键的 Pro 记录（远期 expiresAt）', async () => {
    await idbSet('plan', {
      code: 'LEGACY-CODE-1234',
      tier: 'pro',
      // license-kit 的 perpetual 是 dayjs().add(100, 'year')
      expiresAt: new Date(Date.now() + 100 * 365 * 24 * 3600_000).toISOString(),
      fingerprint: '01JLEGACYULIDFINGERPRINT',
    })

    const plan = await createClient().getPlan()
    expect(plan.tier).toBe('pro')
    expect(plan.limit).toEqual(PRO_LIMIT)
  })

  it('expiresAt: null 视为不过期（extport 对 perpetual 的返回值）', async () => {
    await idbSet('plan', storedConfig({ expiresAt: null }))
    expect((await createClient().getPlan()).tier).toBe('pro')
  })

  it('重新激活时复用历史指纹,不生成新设备', async () => {
    await idbSet('plan', storedConfig({ fingerprint: '01JLEGACYULIDFINGERPRINT', expiresAt: past() }))
    const { calls } = stubWire({ activate: ACTIVATE_OK })

    await createClient().activate('NEW-CODE-5678')

    expect(calls[0]!.url).toBe('https://dash.example.com/api/v1/licensing/activate')
    expect(calls[0]!.body.fingerprint).toBe('01JLEGACYULIDFINGERPRINT')
    expect(calls[0]!.body.productName).toBe('My Product')
    expect(calls[0]!.body.code).toBe('NEW-CODE-5678')
  })
})

describe('套餐解析', () => {
  it('无激活记录时为 free', async () => {
    expect((await createClient().getPlan()).tier).toBe('free')
  })

  it('过期记录回落 free', async () => {
    await idbSet('plan', storedConfig({ expiresAt: past() }))
    expect((await createClient().getPlan()).tier).toBe('free')
  })

  it('未知档位回落 free', async () => {
    await idbSet('plan', storedConfig({ tier: 'enterprise' }))
    expect((await createClient().getPlan()).tier).toBe('free')
  })

  it('override 返回的档位优先于真实记录,不持久化', async () => {
    let forced: Tier | undefined = 'pro'
    const client = createClient({ override: () => forced })
    expect((await client.getPlan()).tier).toBe('pro')
    forced = undefined
    expect((await client.getPlan()).tier).toBe('free')
    expect(await idbGet('plan')).toBeUndefined()
  })
})

describe('activate', () => {
  it('成功后持久化 {code, tier, expiresAt, fingerprint} 并生成随机指纹', async () => {
    stubWire({ activate: ACTIVATE_OK })
    const client = createClient()
    const r = await client.activate('AAAA-BBBB-CCCC-DDDD')
    expect(r.success).toBe(true)

    const stored = (await idbGet('plan')) as PlanConfig
    expect(stored.code).toBe('AAAA-BBBB-CCCC-DDDD')
    expect(stored.tier).toBe('pro')
    expect(stored.expiresAt).toBeNull()
    expect(stored.fingerprint).toMatch(/^[0-9a-f-]{36}$/)
    expect((await client.getPlan()).tier).toBe('pro')
  })

  it('服务端拒绝时返回原响应且不写存储', async () => {
    stubWire({ activate: ACTIVATE_REJECTED })
    const r = await createClient().activate('BAD-CODE')
    expect(r.success).toBe(false)
    expect(await idbGet('plan')).toBeUndefined()
  })
})

describe('checkActivation', () => {
  it('设备有效：返回 true,记录原样保留', async () => {
    await idbSet('plan', storedConfig())
    stubWire({ check: CHECK_ACTIVE })

    expect(await createClient().checkActivation()).toBe(true)
    expect(await idbGet('plan')).toEqual(storedConfig())
  })

  it('设备未激活但重激活成功：自愈,返回 true（座位衰减回归 / 车队迁移窗口）', async () => {
    await idbSet('plan', storedConfig())
    const { calls } = stubWire({ check: CHECK_INACTIVE, activate: ACTIVATE_OK })

    expect(await createClient().checkActivation()).toBe(true)

    // 重激活必须复用存储里的 code + fingerprint
    const activateCall = calls.find((c) => c.url.endsWith('/activate'))!
    expect(activateCall.body.code).toBe('AAAA-BBBB-CCCC-DDDD')
    expect(activateCall.body.fingerprint).toBe('fp-stored')
    expect(((await idbGet('plan')) as PlanConfig).tier).toBe('pro')
  })

  it('设备未激活且重激活被明确拒绝：清除本地状态,返回 false', async () => {
    await idbSet('plan', storedConfig())
    stubWire({ check: CHECK_INACTIVE, activate: ACTIVATE_REJECTED })

    const client = createClient()
    expect(await client.checkActivation()).toBe(false)
    expect(await idbGet('plan')).toBeUndefined()
    expect((await client.getPlan()).tier).toBe('free')
  })

  it('重激活遇到服务端故障：抛出且不清除（瞬态故障 ≠ 吊销）', async () => {
    await idbSet('plan', storedConfig())
    stubWire({ check: CHECK_INACTIVE, activate: () => jsonResponse({ error: 'internal error' }, 500) })

    await expect(createClient().checkActivation()).rejects.toBeInstanceOf(Response)
    expect(await idbGet('plan')).toBeDefined()
  })

  it('check 本身失败：抛出且不清除', async () => {
    await idbSet('plan', storedConfig())
    stubWire({ check: () => jsonResponse({ error: 'internal error' }, 500) })

    await expect(createClient().checkActivation()).rejects.toBeInstanceOf(Response)
    expect(await idbGet('plan')).toBeDefined()
  })

  it('本地无记录：返回 undefined 且不发请求', async () => {
    const { fetchMock } = stubWire({})
    expect(await createClient().checkActivation()).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('默认双后端级联（迁移窗口）', () => {
  const cascade = () => createClient({ apiBase: undefined })

  it('extport 查无此码时回落 legacy,legacy 成功则持久化(保留其远期 expiresAt)', async () => {
    const far = new Date(Date.now() + 100 * 365 * 24 * 3600_000).toISOString()
    const { calls } = stubWire({
      activate: ACTIVATE_REJECTED,
      legacyActivate: () => jsonResponse({ success: true, message: 'ok', data: { tier: 'pro', expiresAt: far } }),
    })
    const r = await cascade().activate('LEGACY-CODE')
    expect(r.success).toBe(true)
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.extport.dev/api/v1/licensing/activate',
      'https://store.rxliuli.com/api/activation/activate',
    ])
    const stored = (await idbGet('plan')) as PlanConfig
    expect(stored.tier).toBe('pro')
    expect(stored.expiresAt).toBe(far)
  })

  it('legacy 的 HTTP 400 是明确拒绝而非故障,且优先返回信息量大的消息', async () => {
    stubWire({
      activate: ACTIVATE_REJECTED,
      legacyActivate: () => jsonResponse({ success: false, message: 'Activation code is no longer active' }, 400),
    })
    const r = await cascade().activate('OLD-CODE')
    expect(r.success).toBe(false)
    expect(r.message).toBe('Activation code is no longer active')
    expect(await idbGet('plan')).toBeUndefined()
  })

  it('extport 明确拒绝但 legacy 不可达:抛出,不下"无效"结论', async () => {
    stubWire({
      activate: ACTIVATE_REJECTED,
      legacyActivate: () => jsonResponse({ error: 'internal error' }, 500),
    })
    await expect(cascade().activate('SOME-CODE')).rejects.toBeInstanceOf(Response)
  })

  it('check 级联:extport 双拒但 legacy 仍激活 → true,状态保留', async () => {
    await idbSet('plan', storedConfig())
    stubWire({
      check: CHECK_INACTIVE,
      activate: ACTIVATE_REJECTED,
      legacyCheck: () => jsonResponse({ success: true, message: 'ok', data: { isActive: true, expiresAt: null } }),
    })
    expect(await cascade().checkActivation()).toBe(true)
    expect(await idbGet('plan')).toBeDefined()
  })

  it('check:extport 整体故障时 legacy 仍激活 → true(故障不参与否定)', async () => {
    await idbSet('plan', storedConfig())
    stubWire({
      check: () => jsonResponse({ error: 'internal error' }, 500),
      legacyCheck: () => jsonResponse({ success: true, message: 'ok', data: { isActive: true, expiresAt: null } }),
    })
    expect(await cascade().checkActivation()).toBe(true)
  })

  it('所有后端对 check 和重激活都明确否定,才清除本地状态', async () => {
    await idbSet('plan', storedConfig())
    stubWire({
      check: CHECK_INACTIVE,
      activate: ACTIVATE_REJECTED,
      legacyCheck: () => jsonResponse({ success: true, message: 'ok', data: { isActive: false, expiresAt: null } }),
      legacyActivate: () => jsonResponse({ success: false, message: 'Invalid activation code' }, 400),
    })
    expect(await cascade().checkActivation()).toBe(false)
    expect(await idbGet('plan')).toBeUndefined()
  })

  it('设置 apiBase 时是单后端模式,不级联 legacy', async () => {
    const { calls } = stubWire({ activate: ACTIVATE_REJECTED })
    const r = await createClient().activate('BAD-CODE')
    expect(r.success).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://dash.example.com/api/v1/licensing/activate')
  })
})

describe('变更通知', () => {
  it('激活与撤销都会广播,监听者拿到新旧档位', async () => {
    const broadcast = vi.fn()
    const listener = vi.fn()
    stubWire({ activate: ACTIVATE_OK })
    const client = createClient({ transport: { broadcast, listen: () => {} } })
    client.subscribe(listener)

    await client.activate('AAAA-BBBB-CCCC-DDDD')
    expect(broadcast).toHaveBeenCalled()
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'pro' }),
      expect.objectContaining({ tier: 'free' }),
    )
  })
})
