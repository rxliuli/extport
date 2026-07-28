// Stripe webhook signature verification, hand-rolled on WebCrypto — the
// scheme is a plain HMAC-SHA256 over `${t}.${rawBody}` (documented and
// stable), and pulling in the stripe SDK for those ~30 lines would be the
// only reason it exists in this codebase. Same philosophy as
// store-adapters talking to store APIs directly.

/** Stripe's default tolerance: reject events signed more than 5 min ago. */
export const STRIPE_SIGNATURE_TOLERANCE_S = 300

interface ParsedSignature {
  timestamp: number
  signatures: string[]
}

/** Header shape: `t=1614556800,v1=abc...,v1=def...` (v0 entries ignored). */
export function parseStripeSignature(header: string): ParsedSignature | null {
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') timestamp = Number.parseInt(value, 10)
    else if (key === 'v1') signatures.push(value)
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return null
  return { timestamp, signatures }
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.byteLength !== bb.byteLength) return false
  // Workers-runtime extension; both inputs are equal-length by the guard above.
  return crypto.subtle.timingSafeEqual(ab, bb)
}

export async function verifyStripeSignature(
  webhookSecret: string,
  rawBody: string,
  signatureHeader: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const parsed = parseStripeSignature(signatureHeader)
  if (!parsed) return false
  if (Math.abs(nowMs / 1000 - parsed.timestamp) > STRIPE_SIGNATURE_TOLERANCE_S) return false
  const expected = await hmacSha256Hex(webhookSecret, `${parsed.timestamp}.${rawBody}`)
  return parsed.signatures.some((sig) => timingSafeEqualStr(sig.toLowerCase(), expected))
}
