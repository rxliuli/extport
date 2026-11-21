import {
  api,
  ApiError,
  type ActivationRow,
  type BillingMode,
  type EntitlementType,
  type Extension,
  type LicenseRow,
  type Plan,
  type SubscriptionRow,
} from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Section, sectionBodyClass, sectionEmptyClass } from '@/components/Section'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { licensesInfiniteQuery, paymentCredentialsQuery, plansQuery, subscriptionsInfiniteQuery } from '@/queries'
import { formatDate } from '@/status'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

// The tenant-side licensing UI: plans (one row per tier + billing model),
// manual license issuance, and per-license device & subscription management
// including the seat release the buyer portal deliberately lacks. See docs/licensing.md.

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

const CURRENCY_OPTIONS = [
  { code: 'USD', label: 'USD ($)' },
  { code: 'EUR', label: 'EUR (€)' },
  { code: 'GBP', label: 'GBP (£)' },
  { code: 'JPY', label: 'JPY (¥)' },
  { code: 'CAD', label: 'CAD ($)' },
  { code: 'AUD', label: 'AUD ($)' },
  { code: 'SGD', label: 'SGD ($)' },
  { code: 'HKD', label: 'HKD ($)' },
  { code: 'CNY', label: 'CNY (¥)' },
] as const

function currencySymbol(currency: string): string {
  try {
    const part = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((p) => p.type === 'currency')
    return part?.value ?? currency.toUpperCase()
  } catch {
    return currency.toUpperCase()
  }
}

function currencyDecimals(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions()
        .maximumFractionDigits ?? 2
    )
  } catch {
    return 2
  }
}

/** amountTotal is Stripe's smallest currency unit; null for manual/imported rows not yet backfilled. */
export function formatAmount(amountTotal: number | null, currency: string | null): string {
  if (amountTotal === null || currency === null) return '—'
  const factor = 10 ** currencyDecimals(currency)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(
    amountTotal / factor,
  )
}

function formatMinorToInput(amount: number | null, currency: string | null): string {
  if (amount === null) return ''
  const decimals = currencyDecimals(currency ?? 'usd')
  return (amount / 10 ** decimals).toFixed(decimals)
}

function parsePriceInput(
  raw: string,
  currency: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, value: null }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: 'Enter a positive price (e.g. 19.99)' }
  }
  const decimals = currencyDecimals(currency)
  const fractional = trimmed.split('.')[1] ?? ''
  if (fractional.length > decimals) {
    return {
      ok: false,
      error:
        decimals === 0
          ? `${currency.toUpperCase()} prices must be whole numbers`
          : `${currency.toUpperCase()} supports at most ${decimals} decimal places`,
    }
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, error: 'Enter a positive price (e.g. 19.99)' }
  }
  const minor = Math.round(parsed * 10 ** decimals)
  if (minor < 50) {
    return { ok: false, error: `Price must be at least ${formatAmount(50, currency)}` }
  }
  if (minor > 99_999_999) {
    return { ok: false, error: 'Price is too large' }
  }
  return { ok: true, value: minor }
}

function formatPlanPricing(plan: Plan): string {
  const currency = plan.currency ?? 'usd'
  if (plan.entitlementType === 'recurring') {
    const parts: string[] = []
    if (plan.monthlyAmount !== null) parts.push(`${formatAmount(plan.monthlyAmount, currency)}/mo`)
    if (plan.yearlyAmount !== null) parts.push(`${formatAmount(plan.yearlyAmount, currency)}/yr`)
    return parts.length > 0 ? parts.join(' · ') : '—'
  }
  return plan.amount !== null ? formatAmount(plan.amount, currency) : '—'
}

function isPlanStripeSynced(plan: Plan): boolean {
  return Boolean(plan.stripeProductId || plan.stripePriceId || plan.stripeMonthlyPriceId || plan.stripeYearlyPriceId)
}

export function formatEntitlementLabel(entitlementType: EntitlementType): string {
  if (entitlementType === 'recurring') return 'subscription'
  if (entitlementType === 'balance') return 'balance'
  return 'one-time'
}

export function LicensePlanCell({ tier, entitlementType }: { tier: string; entitlementType: EntitlementType }) {
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant="secondary">{tier}</Badge>
      {entitlementType === 'recurring' && <span className="text-xs text-muted-foreground">subscription</span>}
    </div>
  )
}

export function LicenseBuyerCell({
  buyerEmail,
  externalUserId,
}: {
  buyerEmail: string
  externalUserId: string | null
}) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground">{buyerEmail}</div>
      {externalUserId && <div className="font-mono text-xs text-muted-foreground/80">{externalUserId}</div>}
    </div>
  )
}

export function LicenseStatusCell({ license }: { license: LicenseRow }) {
  if (license.status !== 'active') {
    return <Badge variant="destructive">{license.status}</Badge>
  }
  if (license.entitlementType !== 'recurring') {
    return <span className="text-muted-foreground">active</span>
  }

  const sub = license.subscriptionStatus
  const periodEnd = license.currentPeriodEnd ? formatDate(license.currentPeriodEnd) : null
  let label = sub ? sub.replace('_', ' ') : 'active'
  let variant: 'secondary' | 'outline' | 'destructive' = 'secondary'
  let hint: string | null = null

  if (sub === 'expired') {
    variant = 'destructive'
    if (periodEnd && license.currentPeriodEnd && new Date(license.currentPeriodEnd).getTime() <= Date.now()) {
      hint = `ended ${periodEnd}`
    }
  } else if (sub === 'past_due') {
    variant = 'destructive'
    if (periodEnd) hint = `due ${periodEnd}`
  } else if (sub === 'canceled') {
    variant = 'outline'
    if (periodEnd) hint = `ends ${periodEnd}`
  } else if (license.cancelAtPeriodEnd) {
    variant = 'outline'
    label = 'canceling'
    if (periodEnd) hint = `ends ${periodEnd}`
  } else if (sub === 'trialing') {
    variant = 'secondary'
    if (periodEnd) hint = `trial ends ${periodEnd}`
  } else if (periodEnd) {
    hint = `renews ${periodEnd}`
  }

  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge variant={variant}>{label}</Badge>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

export function LicensingSection({ extension }: { extension: Extension }) {
  const queryClient = useQueryClient()
  const { data: plans = [] } = useQuery({ ...plansQuery(extension.id), enabled: extension.licensingEnabled })
  const [selectedMode, setSelectedMode] = useState<BillingMode>(extension.billingMode ?? 'license')

  const updateExtension = useMutation({
    mutationFn: (payload: { licensingEnabled?: boolean; billingMode?: BillingMode }) =>
      api(`/api/v1/extensions/${extension.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['extensions'] }),
    onError: (err) => toast.error(errorMessage(err)),
  })

  if (!extension.licensingEnabled) {
    return (
      <Section
        title="Licensing is off"
        description={
          <>
            Choose how this extension is monetized. Each extension uses either one-time activation codes or
            account-based subscriptions — never both — keeping plans, checkout, and verification simple.
          </>
        }
      >
        <div className={`space-y-4 ${sectionBodyClass}`}>
          <RadioGroup
            aria-label="Billing mode"
            value={selectedMode}
            onValueChange={(value: string) => setSelectedMode(value as BillingMode)}
            className="grid max-w-2xl gap-3 sm:grid-cols-2"
          >
            <Label
              htmlFor="ext-billing-license"
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3.5 font-normal transition-colors hover:bg-accent/40 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/50"
            >
              <RadioGroupItem id="ext-billing-license" value="license" className="mt-0.5" />
              <span className="space-y-1">
                <span className="block text-sm font-medium">One-time License</span>
                <span className="block text-xs text-muted-foreground">
                  Perpetual activation codes with device seat limits, verified by @extport/sdk.
                </span>
              </span>
            </Label>
            <Label
              htmlFor="ext-billing-subscription"
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3.5 font-normal transition-colors hover:bg-accent/40 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/50"
            >
              <RadioGroupItem id="ext-billing-subscription" value="subscription" className="mt-0.5" />
              <span className="space-y-1">
                <span className="block text-sm font-medium">Subscription</span>
                <span className="block text-xs text-muted-foreground">
                  Monthly or yearly recurring plans tied to user accounts, verified server-side via API.
                </span>
              </span>
            </Label>
          </RadioGroup>
          <Button
            onClick={() => updateExtension.mutate({ licensingEnabled: true, billingMode: selectedMode })}
            disabled={updateExtension.isPending}
          >
            {selectedMode === 'subscription' ? 'Enable subscriptions' : 'Enable one-time licenses'}
          </Button>
        </div>
      </Section>
    )
  }

  const billingMode: BillingMode =
    extension.billingMode ??
    (plans.some((p) => p.entitlementType === 'recurring') && !plans.some((p) => p.entitlementType === 'perpetual')
      ? 'subscription'
      : 'license')
  const otherMode: BillingMode = billingMode === 'subscription' ? 'license' : 'subscription'

  return (
    <div className="space-y-8">
      <PlansCard extension={extension} billingMode={billingMode} />
      {billingMode === 'subscription' ? (
        <SubscriptionsCard extension={extension} />
      ) : (
        <LicensesCard extension={extension} />
      )}
      <p className="text-sm text-muted-foreground">
        {billingMode === 'subscription' ? (
          <>Billing mode: Subscriptions.</>
        ) : (
          <>
            Billing mode: One-time licenses — switching licensing off stops new activations while already-activated
            devices keep their entitlement from local state.
          </>
        )}{' '}
        {plans.length === 0 && (
          <>
            <button
              type="button"
              className="underline underline-offset-4 hover:text-foreground"
              disabled={updateExtension.isPending}
              onClick={() => updateExtension.mutate({ billingMode: otherMode })}
            >
              Switch to {otherMode === 'subscription' ? 'subscriptions' : 'one-time licenses'}
            </button>
            {' · '}
          </>
        )}
        <button
          type="button"
          className="underline underline-offset-4 hover:text-foreground"
          disabled={updateExtension.isPending}
          onClick={() => updateExtension.mutate({ licensingEnabled: false })}
        >
          Disable licensing
        </button>
      </p>
    </div>
  )
}

function PlanPricingFields({
  idPrefix,
  entitlementType,
  currency,
  onCurrencyChange,
  amount,
  onAmountChange,
  monthlyAmount,
  onMonthlyAmountChange,
  yearlyAmount,
  onYearlyAmountChange,
  hasStripeApiKey,
  helperText,
}: {
  idPrefix: string
  entitlementType: EntitlementType
  currency: string
  onCurrencyChange: (value: string) => void
  amount: string
  onAmountChange: (value: string) => void
  monthlyAmount: string
  onMonthlyAmountChange: (value: string) => void
  yearlyAmount: string
  onYearlyAmountChange: (value: string) => void
  hasStripeApiKey: boolean
  helperText?: string
}) {
  const decimals = currencyDecimals(currency)
  const step = decimals === 0 ? '1' : (1 / 10 ** decimals).toFixed(decimals)
  const min = (50 / 10 ** decimals).toFixed(decimals)
  const max = (99_999_999 / 10 ** decimals).toFixed(decimals)
  const symbol = currencySymbol(currency)
  const options = CURRENCY_OPTIONS.some((c) => c.code === currency)
    ? CURRENCY_OPTIONS
    : [...CURRENCY_OPTIONS, { code: currency, label: `${currency} (${symbol})` }]

  const pricingDisabled = !hasStripeApiKey

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Pricing</span>
        <Select value={currency} onValueChange={onCurrencyChange} disabled={pricingDisabled}>
          <SelectTrigger
            id={`${idPrefix}-currency`}
            size="sm"
            className="w-[110px] bg-background"
            aria-label="Currency"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt.code} value={opt.code}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className={entitlementType === 'recurring' ? 'grid gap-3 sm:grid-cols-2' : 'space-y-1'}>
        {entitlementType === 'perpetual' ? (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-amount`}>One-time price</Label>
            <InputGroup className="bg-background" data-disabled={pricingDisabled || undefined}>
              <InputGroupAddon align="inline-start">
                <InputGroupText>{symbol}</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id={`${idPrefix}-amount`}
                name="amount"
                type="number"
                inputMode="decimal"
                min={min}
                max={max}
                step={step}
                disabled={pricingDisabled}
                placeholder={decimals === 0 ? '2000' : '19.99'}
                value={amount}
                onChange={(e) => onAmountChange(e.target.value)}
              />
            </InputGroup>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-monthly-amount`}>Monthly price</Label>
              <InputGroup className="bg-background" data-disabled={pricingDisabled || undefined}>
                <InputGroupAddon align="inline-start">
                  <InputGroupText>{symbol}</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id={`${idPrefix}-monthly-amount`}
                  name="monthlyAmount"
                  type="number"
                  inputMode="decimal"
                  min={min}
                  max={max}
                  step={step}
                  disabled={pricingDisabled}
                  placeholder={decimals === 0 ? '500' : '4.99'}
                  value={monthlyAmount}
                  onChange={(e) => onMonthlyAmountChange(e.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>/mo</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-yearly-amount`}>Yearly price</Label>
              <InputGroup className="bg-background" data-disabled={pricingDisabled || undefined}>
                <InputGroupAddon align="inline-start">
                  <InputGroupText>{symbol}</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id={`${idPrefix}-yearly-amount`}
                  name="yearlyAmount"
                  type="number"
                  inputMode="decimal"
                  min={min}
                  max={max}
                  step={step}
                  disabled={pricingDisabled}
                  placeholder={decimals === 0 ? '5000' : '49.99'}
                  value={yearlyAmount}
                  onChange={(e) => onYearlyAmountChange(e.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>/yr</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </div>
          </>
        )}
      </div>
      {!hasStripeApiKey ? (
        <p className="text-xs text-muted-foreground">
          Connect your Stripe Restricted Key in{' '}
          <Link to="/settings" hash="payment-credentials" className="underline underline-offset-4">
            Settings
          </Link>{' '}
          to create and sync plans with Stripe.
        </p>
      ) : (
        helperText && <p className="text-xs text-muted-foreground">{helperText}</p>
      )}
    </div>
  )
}

function PlansCard({ extension, billingMode }: { extension: Extension; billingMode: BillingMode }) {
  const queryClient = useQueryClient()
  const { data: plans = [] } = useQuery(plansQuery(extension.id))
  const { data: paymentCredentials = [] } = useQuery(paymentCredentialsQuery)
  const stripeCred = paymentCredentials.find((c) => c.provider === 'stripe')
  const hasStripeApiKey = stripeCred ? (stripeCred.hasApiKey ?? Boolean(stripeCred.apiKeyHint)) : false
  const entitlementType: 'perpetual' | 'recurring' = billingMode === 'subscription' ? 'recurring' : 'perpetual'

  const [open, setOpen] = useState(false)
  // Prefills are suggestions the tenant confirms — never auto-created rows.
  const [tier, setTier] = useState('pro')
  const [maxActivations, setMaxActivations] = useState('3')
  const [currency, setCurrency] = useState('USD')
  const [amount, setAmount] = useState('')
  const [monthlyAmount, setMonthlyAmount] = useState('')
  const [yearlyAmount, setYearlyAmount] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api<{ plan: Plan }>('/api/v1/plans', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setOpen(false)
      setAmount('')
      setMonthlyAmount('')
      setYearlyAmount('')
      setCurrency('USD')
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['extensions', extension.id, 'plans'] })
    },
    onError: (err) => setFormError(errorMessage(err)),
  })

  function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!tier.trim()) return

    const normCurrency = (currency.trim() || 'USD').toLowerCase()
    if (!/^[a-z]{3}$/.test(normCurrency)) {
      setFormError('Currency must be a 3-letter ISO code (e.g. USD)')
      return
    }

    const payload: Record<string, unknown> = {
      extensionId: extension.id,
      tier: tier.trim(),
      entitlementType,
      ...(entitlementType === 'perpetual' ? { maxActivations: Number.parseInt(maxActivations, 10) || 3 } : {}),
    }

    let hasAnyAmount = false
    if (entitlementType === 'perpetual') {
      const parsedAmount = parsePriceInput(amount, normCurrency)
      if (!parsedAmount.ok) {
        setFormError(parsedAmount.error)
        return
      }
      if (parsedAmount.value !== null) {
        payload.amount = parsedAmount.value
        hasAnyAmount = true
      }
    } else {
      const parsedMonthly = parsePriceInput(monthlyAmount, normCurrency)
      if (!parsedMonthly.ok) {
        setFormError(parsedMonthly.error)
        return
      }
      const parsedYearly = parsePriceInput(yearlyAmount, normCurrency)
      if (!parsedYearly.ok) {
        setFormError(parsedYearly.error)
        return
      }
      if (parsedMonthly.value !== null) {
        payload.monthlyAmount = parsedMonthly.value
        hasAnyAmount = true
      }
      if (parsedYearly.value !== null) {
        payload.yearlyAmount = parsedYearly.value
        hasAnyAmount = true
      }
    }

    if (!hasAnyAmount) {
      setFormError(
        entitlementType === 'perpetual'
          ? 'Enter a one-time price to sync with Stripe'
          : 'Enter a monthly and/or yearly price to sync with Stripe',
      )
      return
    }
    payload.currency = normCurrency
    add.mutate(payload)
  }

  return (
    <Section
      title="Plans"
      action={
        <>
          <Dialog
            open={open}
            onOpenChange={(next: boolean) => {
              setOpen(next)
              if (!next) setFormError(null)
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" aria-label="Add a plan">
                <Plus /> <span className="hidden sm:inline">Add a plan</span>
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add a plan</DialogTitle>
              </DialogHeader>
              <form className="flex flex-col gap-3" onSubmit={handleCreateSubmit}>
                <p className="text-xs text-muted-foreground">
                  A plan belongs to this extension — licenses verify against its id (<code>ext_…</code>). Saving creates
                  the Stripe Product and Price(s) automatically.
                </p>
                <div className="space-y-1">
                  <Label htmlFor="plan-tier">Tier</Label>
                  <Input id="plan-tier" name="tier" required value={tier} onChange={(e) => setTier(e.target.value)} />
                  <span className="block text-xs text-muted-foreground">
                    The tier name resolved by your extension (e.g. <code>pro</code>); <code>free</code> is reserved.
                  </span>
                </div>
                {entitlementType === 'perpetual' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="plan-max-activations">Max devices per license</Label>
                    <Input
                      id="plan-max-activations"
                      name="maxActivations"
                      type="number"
                      min={1}
                      max={100}
                      value={maxActivations}
                      onChange={(e) => setMaxActivations(e.target.value)}
                    />
                  </div>
                )}
                <PlanPricingFields
                  idPrefix="plan-create"
                  entitlementType={entitlementType}
                  currency={currency}
                  onCurrencyChange={setCurrency}
                  amount={amount}
                  onAmountChange={setAmount}
                  monthlyAmount={monthlyAmount}
                  onMonthlyAmountChange={setMonthlyAmount}
                  yearlyAmount={yearlyAmount}
                  onYearlyAmountChange={setYearlyAmount}
                  hasStripeApiKey={hasStripeApiKey}
                />
                {formError && (
                  <p role="alert" className="text-xs text-destructive">
                    {formError}
                  </p>
                )}
                <Button type="submit" disabled={add.isPending || !hasStripeApiKey}>
                  {add.isPending ? 'Creating…' : 'Create plan'}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </>
      }
    >
      {plans.length === 0 ? (
        <p className={sectionEmptyClass}>
          {billingMode === 'subscription'
            ? 'No subscription plans yet. Add a tier with monthly and/or yearly pricing to sync with Stripe.'
            : 'No license plans yet. Add a tier with a one-time price and device limit to start issuing codes.'}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tier</TableHead>
              <TableHead>Pricing</TableHead>
              {billingMode === 'license' && <TableHead>Max devices</TableHead>}
              <TableHead>Stripe</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.map((plan) => (
              <TableRow key={plan.id}>
                <TableCell>
                  <Badge variant="secondary">{plan.tier}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{formatPlanPricing(plan)}</TableCell>
                {billingMode === 'license' && <TableCell>{plan.maxActivations}</TableCell>}
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    {isPlanStripeSynced(plan) && (
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary">Synced</Badge>
                        {plan.stripeProductId && (
                          <code className="text-xs text-muted-foreground">{plan.stripeProductId}</code>
                        )}
                      </div>
                    )}
                    <code className="text-xs text-muted-foreground">extport_plan={plan.id}</code>
                  </div>
                </TableCell>
                <TableCell>
                  <PlanEditDialog plan={plan} extensionId={extension.id} hasStripeApiKey={hasStripeApiKey} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}

function PlanEditDialog({
  plan,
  extensionId,
  hasStripeApiKey,
}: {
  plan: Plan
  extensionId: string
  hasStripeApiKey: boolean
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [maxActivations, setMaxActivations] = useState(String(plan.maxActivations))
  const [currency, setCurrency] = useState((plan.currency ?? 'usd').toUpperCase())
  const [amount, setAmount] = useState(formatMinorToInput(plan.amount, plan.currency))
  const [monthlyAmount, setMonthlyAmount] = useState(formatMinorToInput(plan.monthlyAmount, plan.currency))
  const [yearlyAmount, setYearlyAmount] = useState(formatMinorToInput(plan.yearlyAmount, plan.currency))
  const [formError, setFormError] = useState<string | null>(null)

  const syncFromPlan = () => {
    setMaxActivations(String(plan.maxActivations))
    setCurrency((plan.currency ?? 'usd').toUpperCase())
    setAmount(formatMinorToInput(plan.amount, plan.currency))
    setMonthlyAmount(formatMinorToInput(plan.monthlyAmount, plan.currency))
    setYearlyAmount(formatMinorToInput(plan.yearlyAmount, plan.currency))
    setFormError(null)
  }

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api<{ plan: Plan }>(`/api/v1/plans/${plan.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setOpen(false)
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['extensions', extensionId, 'plans'] })
    },
    onError: (err) => setFormError(errorMessage(err)),
  })

  function handleSaveSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)

    const normCurrency = (currency.trim() || 'USD').toLowerCase()
    if (!/^[a-z]{3}$/.test(normCurrency)) {
      setFormError('Currency must be a 3-letter ISO code (e.g. USD)')
      return
    }

    const payload: Record<string, unknown> = {}
    if (plan.entitlementType === 'perpetual') {
      payload.maxActivations = Number.parseInt(maxActivations, 10) || plan.maxActivations
    }

    let pricingTouched = false
    if (plan.entitlementType === 'perpetual') {
      const parsed = parsePriceInput(amount, normCurrency)
      if (!parsed.ok) {
        setFormError(parsed.error)
        return
      }
      if (parsed.value !== plan.amount) {
        payload.amount = parsed.value
        pricingTouched = true
      }
    } else if (plan.entitlementType === 'recurring') {
      const parsedMonthly = parsePriceInput(monthlyAmount, normCurrency)
      if (!parsedMonthly.ok) {
        setFormError(parsedMonthly.error)
        return
      }
      const parsedYearly = parsePriceInput(yearlyAmount, normCurrency)
      if (!parsedYearly.ok) {
        setFormError(parsedYearly.error)
        return
      }
      if (parsedMonthly.value !== plan.monthlyAmount) {
        payload.monthlyAmount = parsedMonthly.value
        pricingTouched = true
      }
      if (parsedYearly.value !== plan.yearlyAmount) {
        payload.yearlyAmount = parsedYearly.value
        pricingTouched = true
      }
    }

    if (plan.currency !== null && normCurrency !== plan.currency) {
      payload.currency = normCurrency
    } else if (pricingTouched) {
      payload.currency = normCurrency
    }

    if (Object.keys(payload).length === 0) {
      setOpen(false)
      return
    }

    save.mutate(payload)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (next) syncFromPlan()
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Edit ${plan.tier} ${formatEntitlementLabel(plan.entitlementType)} plan`}
        >
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Edit {plan.tier} ({formatEntitlementLabel(plan.entitlementType)})
          </DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSaveSubmit}>
          {plan.entitlementType === 'perpetual' && (
            <div className="space-y-1">
              <Label htmlFor={`edit-max-${plan.id}`}>Max devices per license</Label>
              <Input
                id={`edit-max-${plan.id}`}
                name="maxActivations"
                type="number"
                min={1}
                max={100}
                value={maxActivations}
                onChange={(e) => setMaxActivations(e.target.value)}
              />
              <span className="block text-xs text-muted-foreground">
                Applies to licenses issued from now on — already-sold licenses keep the limit they were sold with.
              </span>
            </div>
          )}
          <PlanPricingFields
            idPrefix={`edit-${plan.id}`}
            entitlementType={plan.entitlementType}
            currency={currency}
            onCurrencyChange={setCurrency}
            amount={amount}
            onAmountChange={setAmount}
            monthlyAmount={monthlyAmount}
            onMonthlyAmountChange={setMonthlyAmount}
            yearlyAmount={yearlyAmount}
            onYearlyAmountChange={setYearlyAmount}
            hasStripeApiKey={hasStripeApiKey}
            helperText="Changing a price automatically creates a new Stripe Price and archives the previous one."
          />
          <p className="text-xs text-muted-foreground">
            Tier can't be edited after issuance: installed extensions resolve the tier from their local copy of the
            SDK's tier table, so renaming one would fail every existing device's check. Selling something different?
            Create a new plan.
          </p>
          {formError && (
            <p role="alert" className="text-xs text-destructive">
              {formError}
            </p>
          )}
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SubscriptionStatusCell({ sub }: { sub: SubscriptionRow }) {
  const periodEnd = sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : null
  let label = sub.status.replace('_', ' ')
  let variant: 'secondary' | 'outline' | 'destructive' = 'secondary'
  let hint: string | null = null

  if (sub.status === 'expired') {
    variant = 'destructive'
    if (periodEnd && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).getTime() <= Date.now()) {
      hint = `ended ${periodEnd}`
    }
  } else if (sub.status === 'past_due') {
    variant = 'destructive'
    if (periodEnd) hint = `due ${periodEnd}`
  } else if (sub.status === 'canceled') {
    variant = 'outline'
    if (periodEnd) hint = `ends ${periodEnd}`
  } else if (sub.cancelAtPeriodEnd) {
    variant = 'outline'
    label = 'canceling'
    if (periodEnd) hint = `ends ${periodEnd}`
  } else if (sub.status === 'trialing') {
    variant = 'secondary'
    if (periodEnd) hint = `trial ends ${periodEnd}`
  } else if (periodEnd) {
    hint = `renews ${periodEnd}`
  }

  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge variant={variant}>{label}</Badge>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

function SubscriptionsCard({ extension }: { extension: Extension }) {
  const subsPages = useInfiniteQuery(subscriptionsInfiniteQuery(extension.id))
  const subs = subsPages.data?.pages.flatMap((p) => p.subscriptions) ?? []

  return (
    <Section title="Subscriptions">
      {subs.length === 0 ? (
        <p className={sectionEmptyClass}>
          No subscriptions yet. Account-based subscriptions appear here as Stripe fulfills recurring checkouts.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {subs.map((sub) => (
              <TableRow key={sub.id}>
                <TableCell>
                  <LicenseBuyerCell buyerEmail={sub.buyerEmail} externalUserId={sub.externalUserId} />
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{sub.tier}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{formatAmount(sub.amountTotal, sub.currency)}</TableCell>
                <TableCell>
                  <SubscriptionStatusCell sub={sub} />
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDate(sub.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {subsPages.hasNextPage && (
        <div className="flex justify-center border-t border-border/60 px-5 py-3">
          <Button
            variant="outline"
            size="sm"
            disabled={subsPages.isFetchingNextPage}
            onClick={() => void subsPages.fetchNextPage()}
          >
            Show more
          </Button>
        </div>
      )}
    </Section>
  )
}

function LicensesCard({ extension }: { extension: Extension }) {
  const queryClient = useQueryClient()
  const { data: allPlans = [] } = useQuery(plansQuery(extension.id))
  const plans = allPlans.filter((p) => p.entitlementType === 'perpetual')
  const licensesPages = useInfiniteQuery(licensesInfiniteQuery(extension.id))
  const planById = new Map(plans.map((p) => [p.id, p]))
  const licenses = licensesPages.data?.pages.flatMap((p) => p.licenses) ?? []
  const [open, setOpen] = useState(false)
  const [planId, setPlanId] = useState('')
  const [buyerEmail, setBuyerEmail] = useState('')
  const [externalUserId, setExternalUserId] = useState('')

  const selectedPlanId = planById.has(planId) ? planId : (plans[0]?.id ?? '')

  const issue = useMutation({
    mutationFn: () =>
      api<{ license: LicenseRow }>('/api/v1/licenses', {
        method: 'POST',
        body: JSON.stringify({
          planId: selectedPlanId,
          buyerEmail: buyerEmail.trim(),
          ...(externalUserId.trim() ? { externalUserId: externalUserId.trim() } : {}),
        }),
      }),
    onSuccess: ({ license }) => {
      setOpen(false)
      setBuyerEmail('')
      setExternalUserId('')
      toast.success(`Issued ${license.key}`)
      void queryClient.invalidateQueries({ queryKey: ['licenses'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Section
      title="Licenses"
      action={
        <>
          {plans.length > 0 && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" aria-label="Issue a license">
                  <Plus /> <span className="hidden sm:inline">Issue a license</span>
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Issue a license</DialogTitle>
                </DialogHeader>
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (selectedPlanId && buyerEmail.trim()) issue.mutate()
                  }}
                >
                  <div className="space-y-1">
                    <Label htmlFor="issue-plan">Plan</Label>
                    <Select value={selectedPlanId} onValueChange={setPlanId}>
                      <SelectTrigger id="issue-plan" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {plans.map((plan) => (
                          <SelectItem key={plan.id} value={plan.id}>
                            {plan.tier} ({formatEntitlementLabel(plan.entitlementType)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="issue-email">Buyer email</Label>
                    <Input
                      id="issue-email"
                      name="buyerEmail"
                      type="email"
                      required
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="buyer@example.com"
                      value={buyerEmail}
                      onChange={(e) => setBuyerEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="issue-external-user">External user ID (optional)</Label>
                    <Input
                      id="issue-external-user"
                      name="externalUserId"
                      type="text"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="e.g. user_123"
                      value={externalUserId}
                      onChange={(e) => setExternalUserId(e.target.value)}
                    />
                  </div>
                  <Button type="submit" disabled={issue.isPending}>
                    Issue
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </>
      }
    >
      {licenses.length === 0 ? (
        <p className={sectionEmptyClass}>
          No licenses yet. They appear here as your Stripe webhook fulfills purchases, or when you issue one manually.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Buyer</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {licenses.map((license) => (
              <TableRow key={license.id}>
                <TableCell>
                  <code className="text-xs">{license.key}</code>
                </TableCell>
                <TableCell>
                  <LicensePlanCell tier={license.tier} entitlementType={license.entitlementType} />
                </TableCell>
                <TableCell>
                  <LicenseBuyerCell buyerEmail={license.buyerEmail} externalUserId={license.externalUserId} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatAmount(license.amountTotal, license.currency)}
                </TableCell>
                <TableCell>
                  <LicenseStatusCell license={license} />
                </TableCell>
                <TableCell className="text-muted-foreground">{license.source.replace('_webhook', '')}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(license.createdAt)}</TableCell>
                <TableCell>
                  <DevicesDialog license={license} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {licensesPages.hasNextPage && (
        <div className="flex justify-center border-t border-border/60 px-5 py-3">
          <Button
            variant="outline"
            size="sm"
            disabled={licensesPages.isFetchingNextPage}
            onClick={() => void licensesPages.fetchNextPage()}
          >
            Show more
          </Button>
        </div>
      )}
    </Section>
  )
}

export function DevicesDialog({ license }: { license: LicenseRow }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const detail = useQuery({
    queryKey: ['licenses', license.id],
    queryFn: () => api<{ license: LicenseRow; activations: ActivationRow[] }>(`/api/v1/licenses/${license.id}`),
    enabled: open,
  })

  const release = useMutation({
    mutationFn: (fingerprint: string) =>
      api(`/api/v1/licenses/${license.id}/release`, { method: 'POST', body: JSON.stringify({ fingerprint }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['licenses', license.id] }),
    onError: (err) => toast.error(errorMessage(err)),
  })

  const row = detail.data?.license ?? license
  const active = (detail.data?.activations ?? []).filter((a) => !a.releasedAt)
  const hasMetadata = row.entitlementType === 'recurring' || Boolean(row.externalUserId)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Devices
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Devices · <code className="text-base">{license.key}</code>
          </DialogTitle>
        </DialogHeader>
        {hasMetadata && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border bg-muted/40 p-3 text-xs">
            <div>
              <dt className="text-muted-foreground">Type</dt>
              <dd className="font-medium">{formatEntitlementLabel(row.entitlementType)}</dd>
            </div>
            {row.entitlementType === 'recurring' && (
              <div>
                <dt className="text-muted-foreground">Subscription</dt>
                <dd className="font-medium">
                  {row.subscriptionStatus ?? '—'}
                  {row.cancelAtPeriodEnd ? ' (cancels at period end)' : ''}
                </dd>
              </div>
            )}
            {row.currentPeriodEnd && (
              <div>
                <dt className="text-muted-foreground">Current period</dt>
                <dd className="font-medium">
                  {row.currentPeriodStart ? `${formatDate(row.currentPeriodStart)} → ` : ''}
                  {formatDate(row.currentPeriodEnd)}
                </dd>
              </div>
            )}
            {row.externalUserId && (
              <div>
                <dt className="text-muted-foreground">External user</dt>
                <dd className="font-mono">{row.externalUserId}</dd>
              </div>
            )}
            {row.stripeSubscriptionId && (
              <div className="col-span-2">
                <dt className="text-muted-foreground">Stripe subscription</dt>
                <dd className="font-mono">{row.stripeSubscriptionId}</dd>
              </div>
            )}
          </dl>
        )}
        {detail.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : active.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active devices — all {license.maxActivations} seats free.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {active.length} of {license.maxActivations} seats in use. Idle seats free themselves after 30 days;
              releasing one here is the manual escape hatch for a buyer who asks.
            </p>
            <ul className="space-y-2">
              {active.map((device) => (
                <li key={device.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <div>
                    <code className="text-xs">{device.deviceFingerprint.slice(0, 13)}…</code>
                    <p className="text-xs text-muted-foreground">
                      activated {formatDate(device.activatedAt)}
                      {device.lastHeartbeatAt ? ` · last seen ${formatDate(device.lastHeartbeatAt)}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={release.isPending}
                    onClick={() => release.mutate(device.deviceFingerprint)}
                  >
                    Release seat
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
