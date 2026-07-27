// License keys are the buyer-facing secret and the entire brute-force
// defense for the public activate/check endpoints. Same visual format as
// license-kit, whose imported codes must coexist in the same column:
// 4×4 chars from a 32-char alphabet without the confusable I/O/0/1.
// 16 chars × 5 bits = 80 bits of entropy. license-kit generated these with
// Math.random(); this uses the CSPRNG. 32 divides 256, so `byte & 31`
// introduces no modulo bias.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateLicenseKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31])
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12), chars.slice(12, 16)]
    .map((segment) => segment.join(''))
    .join('-')
}
