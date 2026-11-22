import http from 'node:http'

const PORT = Number(process.env.MOCK_STRIPE_PORT ?? 8791)

let seq = 0
let accountSeq = 0
/** @type {Array<{ method: string; path: string; auth: string | undefined; stripeAccount: string | string[] | undefined; params: Record<string, string> }>} */
let requests = []
/** @type {Map<string, { id: string; status: string; subscription: string; phases: Array<{ start_date: number; end_date: number; items: Array<{ price: string; quantity: number }> }> }>} */
let schedules = new Map()
/** @type {Map<string, string>} */
let subSchedules = new Map()
/** @type {Map<string, boolean>} */
let subCancelAtPeriodEnd = new Map()

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const method = req.method ?? 'GET'

  if (method === 'GET' && url.pathname === '/__health') {
    return sendJson(res, 200, { ok: true })
  }
  if (method === 'GET' && url.pathname === '/__requests') {
    return sendJson(res, 200, { requests })
  }
  if (method === 'POST' && url.pathname === '/__reset') {
    seq = 0
    requests = []
    schedules = new Map()
    subSchedules = new Map()
    subCancelAtPeriodEnd = new Map()
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'GET' && url.pathname === '/oauth/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state') ?? ''
    if (!redirectUri) {
      return sendJson(res, 400, { error: 'missing redirect_uri' })
    }
    const target = new URL(redirectUri)
    target.searchParams.set('code', `ac_e2e_${++accountSeq}`)
    target.searchParams.set('state', state)
    res.writeHead(302, { location: target.toString() })
    return res.end()
  }

  const rawBody = await readBody(req)
  const params = Object.fromEntries(new URLSearchParams(rawBody).entries())

  if (method === 'POST' && url.pathname === '/oauth/token') {
    const id = `acct_e2e_${accountSeq || ++accountSeq}`
    return sendJson(res, 200, { stripe_user_id: id, livemode: false, scope: 'read_write' })
  }

  if (method === 'POST' && url.pathname === '/oauth/deauthorize') {
    return sendJson(res, 200, { stripe_user_id: params.stripe_user_id ?? '' })
  }

  requests.push({
    method,
    path: url.pathname,
    auth: req.headers.authorization,
    stripeAccount: req.headers['stripe-account'],
    params,
  })

  if (method === 'POST' && url.pathname === '/v1/products') {
    const id = `prod_e2e_${++seq}`
    return sendJson(res, 200, { id, object: 'product', name: params.name ?? '' })
  }

  if (method === 'POST' && url.pathname === '/v1/prices') {
    const id = `price_e2e_${++seq}`
    return sendJson(res, 200, {
      id,
      object: 'price',
      product: params.product,
      unit_amount: Number(params.unit_amount ?? 0),
      currency: params.currency ?? 'usd',
    })
  }

  if (method === 'POST' && url.pathname.startsWith('/v1/prices/')) {
    const id = decodeURIComponent(url.pathname.slice('/v1/prices/'.length))
    return sendJson(res, 200, { id, object: 'price', active: params.active !== 'false' })
  }

  if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
    const id = `cs_e2e_${++seq}`
    return sendJson(res, 200, {
      id,
      object: 'checkout.session',
      url: `https://checkout.stripe.test/c/pay/${id}`,
    })
  }

  if (method === 'POST' && url.pathname === '/v1/billing_portal/sessions') {
    const id = `bps_e2e_${++seq}`
    return sendJson(res, 200, {
      id,
      object: 'billing_portal.session',
      url: `https://billing.stripe.test/p/session/${id}`,
    })
  }

  if (method === 'GET' && url.pathname.startsWith('/v1/subscriptions/')) {
    const id = decodeURIComponent(url.pathname.slice('/v1/subscriptions/'.length))
    const nowSec = Math.floor(Date.now() / 1000)
    const endSec = nowSec + 30 * 24 * 60 * 60
    return sendJson(res, 200, {
      id,
      object: 'subscription',
      status: 'active',
      cancel_at_period_end: subCancelAtPeriodEnd.get(id) ?? false,
      cancel_at: null,
      current_period_start: nowSec,
      current_period_end: endSec,
      schedule: subSchedules.get(id) ?? null,
      items: {
        data: [
          {
            current_period_start: nowSec,
            current_period_end: endSec,
            price: { id: 'price_e2e_current' },
          },
        ],
      },
    })
  }

  if (method === 'POST' && url.pathname.startsWith('/v1/subscriptions/')) {
    const id = decodeURIComponent(url.pathname.slice('/v1/subscriptions/'.length))
    const cancel = params.cancel_at_period_end === 'true'
    subCancelAtPeriodEnd.set(id, cancel)
    return sendJson(res, 200, {
      id,
      object: 'subscription',
      status: 'active',
      cancel_at_period_end: cancel,
      cancel_at: null,
    })
  }

  if (method === 'POST' && url.pathname === '/v1/subscription_schedules') {
    const subId = params.from_subscription
    const id = `sub_sched_e2e_${++seq}`
    const nowSec = Math.floor(Date.now() / 1000)
    const endSec = nowSec + 30 * 24 * 60 * 60
    const sched = {
      id,
      object: 'subscription_schedule',
      status: 'active',
      subscription: subId,
      phases: [
        {
          start_date: nowSec,
          end_date: endSec,
          items: [{ price: 'price_e2e_current', quantity: 1 }],
        },
      ],
    }
    schedules.set(id, sched)
    if (subId) subSchedules.set(subId, id)
    return sendJson(res, 200, sched)
  }

  if (method === 'GET' && url.pathname.startsWith('/v1/subscription_schedules/')) {
    const id = decodeURIComponent(url.pathname.slice('/v1/subscription_schedules/'.length))
    const sched = schedules.get(id)
    if (!sched) return sendJson(res, 404, { error: { message: `No such subscription schedule: ${id}` } })
    return sendJson(res, 200, sched)
  }

  if (method === 'POST' && url.pathname.startsWith('/v1/subscription_schedules/') && url.pathname.endsWith('/release')) {
    const id = decodeURIComponent(
      url.pathname.slice('/v1/subscription_schedules/'.length, -'/release'.length),
    )
    const sched = schedules.get(id)
    if (!sched) return sendJson(res, 404, { error: { message: `No such subscription schedule: ${id}` } })
    sched.status = 'released'
    if (sched.subscription && subSchedules.get(sched.subscription) === id) {
      subSchedules.delete(sched.subscription)
    }
    return sendJson(res, 200, sched)
  }

  if (method === 'POST' && url.pathname.startsWith('/v1/subscription_schedules/')) {
    const id = decodeURIComponent(url.pathname.slice('/v1/subscription_schedules/'.length))
    const sched = schedules.get(id)
    if (!sched) return sendJson(res, 404, { error: { message: `No such subscription schedule: ${id}` } })
    sched.phases = [
      {
        start_date: Number(params['phases[0][start_date]'] ?? sched.phases[0]?.start_date ?? 0),
        end_date: Number(params['phases[0][end_date]'] ?? sched.phases[0]?.end_date ?? 0),
        items: [{ price: params['phases[0][items][0][price]'] ?? 'price_e2e_current', quantity: 1 }],
      },
      {
        start_date: Number(params['phases[0][end_date]'] ?? 0),
        end_date: 0,
        items: [{ price: params['phases[1][items][0][price]'] ?? '', quantity: 1 }],
      },
    ]
    return sendJson(res, 200, sched)
  }

  if (method === 'GET' && url.pathname === '/v1/invoices') {
    return sendJson(res, 200, {
      object: 'list',
      data: [
        {
          id: 'in_e2e_1',
          number: 'INV-E2E-0001',
          status: 'paid',
          amount_paid: 599,
          currency: 'usd',
          created: Math.floor(Date.now() / 1000),
          invoice_pdf: 'https://pay.stripe.test/invoice/in_e2e_1/pdf',
          hosted_invoice_url: 'https://invoice.stripe.test/i/in_e2e_1',
        },
      ],
    })
  }

  return sendJson(res, 404, { error: { message: `Unhandled mock Stripe route: ${method} ${url.pathname}` } })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-stripe] listening on http://127.0.0.1:${PORT}`)
})

const shutdown = () => {
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
