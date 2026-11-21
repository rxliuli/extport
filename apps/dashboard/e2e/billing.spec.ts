import crypto from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'

const MOCK_STRIPE_URL = `http://127.0.0.1:${process.env.MOCK_STRIPE_PORT ?? 8791}`
const WEBHOOK_SECRET = 'whsec_e2e_billing_secret_9876'
const RESTRICTED_KEY = 'rk_test_e2e_restricted_key_1234'

interface RecordedStripeRequest {
  method: string
  path: string
  auth?: string
  params: Record<string, string>
}

async function resetMockStripe(): Promise<void> {
  const res = await fetch(`${MOCK_STRIPE_URL}/__reset`, { method: 'POST' })
  expect(res.ok).toBe(true)
}

async function getStripeRequests(): Promise<RecordedStripeRequest[]> {
  const res = await fetch(`${MOCK_STRIPE_URL}/__requests`)
  expect(res.ok).toBe(true)
  const data = (await res.json()) as { requests: RecordedStripeRequest[] }
  return data.requests
}

function signStripeWebhook(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex')
  return `t=${timestamp},v1=${sig}`
}

async function postStripeWebhook(page: Page, tenantId: string, event: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify(event)
  const signature = signStripeWebhook(payload, WEBHOOK_SECRET)
  const res = await page.request.post(`/api/v1/licensing/webhooks/stripe/${tenantId}`, {
    data: payload,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
  })
  expect(res.status(), await res.text()).toBe(200)
}

async function loginAsFreshTenant(page: Page, subject: string): Promise<{ tenantId: string }> {
  await page.goto(`/api/auth/dev-login?subject=${encodeURIComponent(subject)}`)
  await expect(page.getByRole('heading', { name: 'Extensions', level: 1 })).toBeVisible()
  const meRes = await page.request.get('/api/v1/me')
  expect(meRes.status()).toBe(200)
  const me = (await meRes.json()) as { tenant: { id: string } }
  return { tenantId: me.tenant.id }
}

async function configureStripeInSettings(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Stripe', level: 2 })).toBeVisible()

  await page.locator('#stripe-restricted-key').fill(RESTRICTED_KEY)
  await page.getByRole('button', { name: 'Save key' }).click()
  await expect(page.getByText('rk_…1234')).toBeVisible()

  await page.locator('#stripe-webhook-secret').fill(WEBHOOK_SECRET)
  await page.getByRole('button', { name: 'Save secret' }).click()
  await expect(page.getByText('whsec_…9876')).toBeVisible()
}

async function createExtensionAndOpenLicensing(page: Page, name: string): Promise<string> {
  await page.getByRole('link', { name: 'Extensions' }).click()
  await expect(page.getByRole('heading', { name: 'Extensions', level: 1 })).toBeVisible()
  await page.getByPlaceholder('New extension name').fill(name)
  await page.getByRole('button', { name: 'Add extension' }).click()

  const extLink = page.getByRole('link', { name, exact: true }).first()
  await expect(extLink).toBeVisible()
  const href = await extLink.getAttribute('href')
  expect(href).toBeTruthy()
  const extensionId = href!.split('/').pop()!

  await page.goto(`/extensions/${extensionId}/licensing`)
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
  return extensionId
}

test.describe('Billing & payment UI E2E', () => {
  let pageErrors: Error[] = []

  test.beforeEach(async ({ page }) => {
    pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err))
    await resetMockStripe()
  })

  test.afterEach(() => {
    expect(pageErrors, `Uncaught page errors: ${pageErrors.map((e) => e.message).join('; ')}`).toEqual([])
  })

  test('gates plan pricing behind Stripe Restricted Key and persists Stripe credentials', async ({ page }) => {
    await loginAsFreshTenant(page, `e2e-settings-${Date.now()}`)
    const extensionId = await createExtensionAndOpenLicensing(page, 'Key Gate Ext')

    // Enable subscription mode before configuring Stripe Restricted Key.
    await page.getByRole('radio', { name: /Subscription/i }).click()
    await page.getByRole('button', { name: 'Enable subscriptions' }).click()

    // Add a plan dialog should disable pricing fields and link to Settings -> Stripe.
    await page.getByRole('button', { name: 'Add a plan' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add a plan' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/Connect your Stripe Restricted Key in/i)).toBeVisible()
    await expect(dialog.getByLabel('Monthly price')).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Create plan' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Close' }).click()

    // Configure Stripe credentials in Settings and verify they persist across reload.
    await configureStripeInSettings(page)
    await page.reload()
    await expect(page.getByText('rk_…1234')).toBeVisible()
    await expect(page.getByText('whsec_…9876')).toBeVisible()

    // Return to Licensing -> pricing inputs are now enabled and USD-only (no currency dropdown).
    await page.goto(`/extensions/${extensionId}/licensing`)
    await page.getByRole('button', { name: 'Add a plan' }).click()
    await expect(dialog.getByLabel('Monthly price (USD)')).toBeEnabled()
    await expect(dialog.getByLabel('Currency')).toHaveCount(0)
  })

  test('subscription lifecycle: USD plans reuse one Stripe Product, checkout, webhook fulfillment, duplicate guard, and disable pause', async ({
    page,
  }) => {
    const { tenantId } = await loginAsFreshTenant(page, `e2e-sub-${Date.now()}`)
    await configureStripeInSettings(page)
    const extensionId = await createExtensionAndOpenLicensing(page, 'Sub Pro Ext')

    // Choose mutually exclusive Subscription billing mode.
    await page.getByRole('radio', { name: /Subscription/i }).click()
    await page.getByRole('button', { name: 'Enable subscriptions' }).click()

    await expect(page.getByRole('heading', { name: 'Subscriptions', level: 2 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Licenses', level: 2 })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Switch to one-time licenses' })).toBeVisible()

    // Create first subscription plan ("pro" Monthly) and verify min price validation first.
    await page.getByRole('button', { name: 'Add a plan' }).click()
    const createDialog = page.getByRole('dialog', { name: 'Add a plan' })
    await createDialog.getByLabel('Monthly price').fill('0.10')
    await createDialog.getByRole('button', { name: 'Create plan' }).click()
    // Native HTML5 min=0.50 validation keeps dialog open and makes no Stripe calls.
    await expect(createDialog).toBeVisible()
    expect(await getStripeRequests()).toHaveLength(0)

    await createDialog.getByLabel('Monthly price').fill('4.99')
    await createDialog.getByRole('button', { name: 'Create plan' }).click()
    await expect(createDialog).toBeHidden()

    await expect(page.getByText('$4.99/mo')).toBeVisible()
    await expect(page.getByText('Monthly', { exact: true })).toBeVisible()
    await expect(page.getByText('prod_e2e_1')).toBeVisible()
    // Billing mode switch disappears once a plan exists.
    await expect(page.getByRole('button', { name: 'Switch to one-time licenses' })).toHaveCount(0)

    // Capture the created pro monthly plan ID from the UI row.
    const proPlanCode = await page
      .locator('code', { hasText: /extport_plan=plan_/ })
      .first()
      .textContent()
    const proPlanId = proPlanCode!.trim().replace(/^extport_plan=/, '')

    // Create second subscription plan ("pro" Yearly) and assert it reuses the SAME Stripe Product.
    await page.getByRole('button', { name: 'Add a plan' }).click()
    await createDialog.getByRole('radio', { name: 'Yearly' }).click()
    await createDialog.getByLabel('Yearly price').fill('49.99')
    await createDialog.getByRole('button', { name: 'Create plan' }).click()
    await expect(createDialog).toBeHidden()

    await expect(page.getByText('$49.99/yr')).toBeVisible()
    await expect(page.getByText('Yearly', { exact: true })).toBeVisible()
    await expect(page.getByText('prod_e2e_1')).toHaveCount(2)

    const stripeCallsAfterPlans = await getStripeRequests()
    const productCreates = stripeCallsAfterPlans.filter((r) => r.method === 'POST' && r.path === '/v1/products')
    expect(productCreates).toHaveLength(1)
    expect(productCreates[0]!.params.name).toBe('Sub Pro Ext')
    expect(productCreates[0]!.params['metadata[extport_extension]']).toBe(extensionId)

    // Edit "pro" monthly price -> creates new Stripe Price and archives old price_e2e_2.
    await page.getByRole('button', { name: 'Edit pro monthly plan' }).click()
    const editDialog = page.getByRole('dialog', { name: 'Edit pro (monthly)' })
    await expect(editDialog.getByLabel('Currency')).toHaveCount(0)
    await editDialog.getByLabel('Monthly price (USD)').fill('5.99')
    await editDialog.getByRole('button', { name: 'Save' }).click()
    await expect(editDialog).toBeHidden()
    await expect(page.getByText('$5.99/mo')).toBeVisible()

    const stripeCallsAfterEdit = await getStripeRequests()
    expect(stripeCallsAfterEdit.some((r) => r.path === '/v1/prices/price_e2e_2' && r.params.active === 'false')).toBe(
      true,
    )

    // Create a checkout session while enabled (using planId directly, no interval needed).
    const checkoutRes = await page.request.post('/api/v1/subscriptions/checkout', {
      data: {
        extensionId,
        planId: proPlanId,
        externalUserId: 'usr_alice_e2e',
        email: 'alice@example.com',
        successUrl: 'http://localhost:5174/?ok=1',
        cancelUrl: 'http://localhost:5174/?cancel=1',
      },
    })
    expect(checkoutRes.status()).toBe(200)
    const checkoutBody = (await checkoutRes.json()) as { action: string; url: string; sessionId: string }
    expect(checkoutBody.action).toBe('checkout')
    expect(checkoutBody.url).toContain('https://checkout.stripe.test/c/pay/')

    // Fulfill subscription via signed Stripe webhooks and verify UI Subscriptions table updates.
    const nowSec = Math.floor(Date.now() / 1000)
    const periodEndSec = nowSec + 30 * 24 * 60 * 60
    await postStripeWebhook(page, tenantId, {
      id: 'evt_e2e_sub_checkout_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: checkoutBody.sessionId,
          mode: 'subscription',
          payment_status: 'paid',
          customer: 'cus_alice_e2e',
          subscription: 'sub_alice_e2e',
          client_reference_id: 'usr_alice_e2e',
          amount_total: 599,
          currency: 'usd',
          customer_details: { email: 'alice@example.com' },
          metadata: { extport_plan: proPlanId },
        },
      },
    })
    await postStripeWebhook(page, tenantId, {
      id: 'evt_e2e_sub_created_1',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_alice_e2e',
          customer: 'cus_alice_e2e',
          status: 'active',
          cancel_at_period_end: false,
          items: {
            data: [{ current_period_start: nowSec, current_period_end: periodEndSec }],
          },
          metadata: { extport_plan: proPlanId },
        },
      },
    })

    await page.reload()
    await expect(page.getByText('alice@example.com')).toBeVisible()
    await expect(page.getByText('usr_alice_e2e')).toBeVisible()
    await expect(page.getByText('$5.99', { exact: true })).toBeVisible()

    // Buyer checkout-success page renders clean subscription confirmation (no activation code).
    await page.goto(`/purchase/success?session_id=${encodeURIComponent(checkoutBody.sessionId)}`)
    await expect(page.getByText('Thanks for subscribing to Sub Pro Ext (pro)!')).toBeVisible()
    await expect(page.getByText('Your subscription is now active.')).toBeVisible()
    await expect(page.getByText('Your activation code:')).toHaveCount(0)
    await page.goto(`/extensions/${extensionId}/licensing`)

    // Duplicate checkout for an already-subscribed user redirects to Billing Portal.
    const dupCheckoutRes = await page.request.post('/api/v1/subscriptions/checkout', {
      data: {
        extensionId,
        planId: proPlanId,
        interval: 'monthly',
        externalUserId: 'usr_alice_e2e',
        email: 'alice@example.com',
        successUrl: 'http://localhost:5174/?ok=1',
        cancelUrl: 'http://localhost:5174/?cancel=1',
      },
    })
    expect(dupCheckoutRes.status()).toBe(200)
    const dupBody = (await dupCheckoutRes.json()) as { action: string; reason: string; url: string }
    expect(dupBody.action).toBe('portal')
    expect(dupBody.reason).toBe('already_subscribed')
    expect(dupBody.url).toContain('https://billing.stripe.test/p/session/')

    // Disable licensing: paused UI hides billing-mode radio switcher, blocks new checkout,
    // and keeps entitlements + billing portal active for existing subscribers.
    await page.getByRole('button', { name: 'Disable licensing' }).click()
    await expect(page.getByRole('heading', { name: 'Licensing is off', level: 2 })).toBeVisible()
    await expect(page.getByText(/New subscription checkouts are paused/i)).toBeVisible()
    await expect(page.getByRole('radiogroup', { name: 'Billing mode' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Re-enable subscriptions' })).toBeVisible()

    const blockedCheckoutRes = await page.request.post('/api/v1/subscriptions/checkout', {
      data: {
        extensionId,
        planId: proPlanId,
        interval: 'monthly',
        externalUserId: 'usr_new_buyer',
        email: 'new@example.com',
        successUrl: 'http://localhost:5174/?ok=1',
        cancelUrl: 'http://localhost:5174/?cancel=1',
      },
    })
    expect(blockedCheckoutRes.status()).toBe(400)

    const entRes = await page.request.get(
      `/api/v1/subscriptions/entitlements?extensionId=${extensionId}&externalUserId=usr_alice_e2e`,
    )
    expect(entRes.status()).toBe(200)
    const entBody = (await entRes.json()) as { active: boolean; tier: string }
    expect(entBody.active).toBe(true)
    expect(entBody.tier).toBe('pro')

    const portalRes = await page.request.post('/api/v1/subscriptions/portal', {
      data: {
        extensionId,
        externalUserId: 'usr_alice_e2e',
        returnUrl: 'http://localhost:5174/',
      },
    })
    expect(portalRes.status()).toBe(200)

    // Re-enable subscriptions -> plans & subscriber row return cleanly.
    await page.getByRole('button', { name: 'Re-enable subscriptions' }).click()
    await expect(page.getByText('$5.99/mo')).toBeVisible()
    await expect(page.getByText('alice@example.com')).toBeVisible()
  })

  test('one-time license lifecycle: plan creation, webhook fulfillment, manual issuance, and disable guard', async ({
    page,
  }) => {
    const { tenantId } = await loginAsFreshTenant(page, `e2e-lic-${Date.now()}`)
    await configureStripeInSettings(page)
    const extensionId = await createExtensionAndOpenLicensing(page, 'License Pro Ext')

    // One-time License is selected by default.
    await expect(page.getByRole('radio', { name: /One-time License/i })).toBeChecked()
    await page.getByRole('button', { name: 'Enable one-time licenses' }).click()

    await expect(page.getByRole('heading', { name: 'Licenses', level: 2 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Subscriptions', level: 2 })).toHaveCount(0)

    // Create one-time plan ("pro", $19.99, 3 devices).
    await page.getByRole('button', { name: 'Add a plan' }).click()
    const createDialog = page.getByRole('dialog', { name: 'Add a plan' })
    await createDialog.getByLabel('One-time price (USD)').fill('19.99')
    await createDialog.getByRole('button', { name: 'Create plan' }).click()
    await expect(createDialog).toBeHidden()

    await expect(page.getByText('$19.99')).toBeVisible()
    await expect(page.getByText('prod_e2e_1')).toBeVisible()
    const proPlanId = (await page
      .locator('code', { hasText: /extport_plan=plan_/ })
      .first()
      .textContent())!
      .trim()
      .replace(/^extport_plan=/, '')

    // Fulfill a Stripe one-time checkout webhook and verify license appears in UI.
    await postStripeWebhook(page, tenantId, {
      id: 'evt_e2e_lic_checkout_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_e2e_lic_1',
          mode: 'payment',
          payment_status: 'paid',
          payment_intent: 'pi_e2e_lic_1',
          customer: 'cus_bob_e2e',
          amount_total: 1999,
          currency: 'usd',
          customer_details: { email: 'bob@example.com' },
          metadata: { extport_plan: proPlanId },
        },
      },
    })

    await page.reload()
    await expect(page.getByText('bob@example.com')).toBeVisible()
    await expect(page.getByText('stripe', { exact: true })).toBeVisible()

    // Issue a manual license via the UI dialog.
    await page.getByRole('button', { name: 'Issue a license' }).click()
    const issueDialog = page.getByRole('dialog', { name: 'Issue a license' })
    await issueDialog.getByLabel('Buyer email').fill('manual@example.com')
    await issueDialog.getByRole('button', { name: 'Issue', exact: true }).click()
    await expect(issueDialog).toBeHidden()

    await expect(page.getByText('manual@example.com')).toBeVisible()
    await expect(page.getByText('manual', { exact: true })).toBeVisible()

    // Disable licensing: paused UI has no radio switcher and blocks new one-time checkout.
    await page.getByRole('button', { name: 'Disable licensing' }).click()
    await expect(page.getByRole('heading', { name: 'Licensing is off', level: 2 })).toBeVisible()
    await expect(page.getByRole('radiogroup', { name: 'Billing mode' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Re-enable one-time licenses' })).toBeVisible()

    const blockedCheckout = await page.request.post('/api/v1/licensing/checkout', {
      data: {
        extensionId,
        planId: proPlanId,
        email: 'blocked@example.com',
        successUrl: 'http://localhost:5174/?ok=1',
        cancelUrl: 'http://localhost:5174/?cancel=1',
      },
    })
    expect(blockedCheckout.status()).toBe(400)
  })
})
