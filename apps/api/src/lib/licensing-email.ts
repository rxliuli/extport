// The fulfillment email — the only artifact a buyer receives for their
// purchase, so unlike operational notifications (lib/notify.ts, which
// swallows send failures) this one propagates errors: the webhook handler
// turns them into a 5xx so the failure is at least visible in the
// tenant's Stripe delivery log instead of silently losing the code.

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export interface LicenseEmail {
  to: string
  productName: string
  tier: string
  key: string
  maxActivations: number
}

export async function sendLicenseEmail(env: Env, email: LicenseEmail): Promise<void> {
  const text = [
    `Thanks for purchasing ${email.productName} (${email.tier})!`,
    '',
    `Your activation code:`,
    '',
    `    ${email.key}`,
    '',
    `Open the extension's settings and enter this code to activate. The`,
    `license covers up to ${email.maxActivations} devices.`,
    '',
    `Keep this email — the code is your proof of purchase.`,
  ].join('\n')
  const html = [
    `<p>Thanks for purchasing <strong>${escapeHtml(email.productName)}</strong> (${escapeHtml(email.tier)})!</p>`,
    `<p>Your activation code:</p>`,
    `<p style="font:20px/1.6 ui-monospace,monospace;letter-spacing:1px"><strong>${escapeHtml(email.key)}</strong></p>`,
    `<p>Open the extension's settings and enter this code to activate. The license covers up to ${email.maxActivations} devices.</p>`,
    `<p>Keep this email — the code is your proof of purchase.</p>`,
  ].join('\n')
  await env.EMAIL.send({
    to: email.to,
    from: { email: env.NOTIFICATION_FROM_EMAIL, name: email.productName },
    subject: `Your ${email.productName} activation code`,
    text,
    html,
  })
}
