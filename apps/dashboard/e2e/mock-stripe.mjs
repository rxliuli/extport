import http from 'node:http'

const PORT = Number(process.env.MOCK_STRIPE_PORT ?? 8791)

let seq = 0
/** @type {Array<{ method: string; path: string; auth: string | undefined; params: Record<string, string> }>} */
let requests = []

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
    return sendJson(res, 200, { ok: true })
  }

  const rawBody = await readBody(req)
  const params = Object.fromEntries(new URLSearchParams(rawBody).entries())
  requests.push({
    method,
    path: url.pathname,
    auth: req.headers.authorization,
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
