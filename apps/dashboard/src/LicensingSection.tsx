import {
  api,
  ApiError,
  type ActivationRow,
  type BillingInterval,
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
import { parseDeviceAgent } from '@/lib/device-info'
import { cn } from '@/lib/utils'
import { licensesInfiniteQuery, paymentCredentialsQuery, plansQuery, subscriptionsInfiniteQuery } from '@/queries'
import { formatDate } from '@/status'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

// The tenant-side licensing UI: plans (one row per tier + billing model),
// manual license issuance, and per-license device & subscription management
// including the seat release the buyer portal deliberately lacks. See docs/licensing.md.

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
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

function formatMinorToInput(amount: number, currency: string): string {
  const decimals = currencyDecimals(currency)
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

function formatBillingInterval(interval: BillingInterval): string {
  if (interval === 'month') return 'Monthly'
  if (interval === 'year') return 'Yearly'
  return 'One-time'
}

function formatPlanPricing(plan: Plan): string {
  const formatted = formatAmount(plan.amount, plan.currency)
  if (plan.billingInterval === 'month') return `${formatted}/mo`
  if (plan.billingInterval === 'year') return `${formatted}/yr`
  return formatted
}

function isPlanStripeSynced(plan: Plan): boolean {
  return Boolean(plan.stripeProductId || plan.stripePriceId)
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
  const { data: plans = [] } = useQuery(plansQuery(extension.id))
  const { data: paymentCredentials = [], isLoading: credentialsLoading } = useQuery(paymentCredentialsQuery)
  const stripeCred = paymentCredentials.find((c) => c.provider === 'stripe')
  const stripeConnected = Boolean(stripeCred?.connected || stripeCred?.stripeAccountId)
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

  const billingMode: BillingMode =
    extension.billingMode ??
    (plans.some((p) => p.entitlementType === 'recurring') && !plans.some((p) => p.entitlementType === 'perpetual')
      ? 'subscription'
      : 'license')

  if (!extension.licensingEnabled) {
    const modeLocked = plans.length > 0
    if (!credentialsLoading && !stripeConnected) {
      return (
        <Section
          title="Connect Stripe to enable licensing"
          description="Licensing requires a connected Stripe account to manage plans, prices, checkouts, and billing."
        >
          <div className={`flex flex-wrap items-center justify-between gap-3 ${sectionBodyClass}`}>
            <p className="text-sm text-muted-foreground">
              Connect your Stripe account in Settings first, then return here to enable{' '}
              {modeLocked
                ? billingMode === 'subscription'
                  ? 'subscriptions'
                  : 'one-time licenses'
                : 'one-time licenses or subscriptions'}
              .
            </p>
            <Button asChild>
              <Link to="/settings" hash="payment-credentials">
                Connect Stripe in Settings
              </Link>
            </Button>
          </div>
        </Section>
      )
    }

    return (
      <Section
        title="Licensing is off"
        description={
          modeLocked ? (
            billingMode === 'subscription' ? (
              <>
                New subscription checkouts are paused. Existing subscribers keep access for their paid period and can
                still manage billing.
              </>
            ) : (
              <>
                New checkouts and new device activations are paused. Already-activated devices keep their entitlement
                from local state.
              </>
            )
          ) : (
            <>
              Choose how this extension is monetized. Each extension uses either one-time activation codes or
              account-based subscriptions — never both — keeping plans, checkout, and verification simple.
            </>
          )
        }
      >
        <div className={`space-y-4 ${sectionBodyClass}`}>
          {!modeLocked && (
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
          )}
          <Button
            onClick={() =>
              updateExtension.mutate(
                modeLocked ? { licensingEnabled: true } : { licensingEnabled: true, billingMode: selectedMode },
              )
            }
            disabled={updateExtension.isPending || credentialsLoading}
          >
            {modeLocked
              ? billingMode === 'subscription'
                ? 'Re-enable subscriptions'
                : 'Re-enable one-time licenses'
              : selectedMode === 'subscription'
                ? 'Enable subscriptions'
                : 'Enable one-time licenses'}
          </Button>
        </div>
      </Section>
    )
  }

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
          <>
            Billing mode: Subscriptions — disabling stops new checkouts while existing subscribers keep access for their
            paid period and can still manage billing.
          </>
        ) : (
          <>
            Billing mode: One-time licenses — disabling stops new checkouts and new device activations while
            already-activated devices keep their entitlement from local state.
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
  billingInterval,
  onBillingIntervalChange,
  amount,
  onAmountChange,
  hasStripeApiKey,
  helperText,
}: {
  idPrefix: string
  billingInterval: BillingInterval
  /** When provided, lets the user pick Monthly vs Yearly (used in Create dialog for subscriptions). */
  onBillingIntervalChange?: (value: 'month' | 'year') => void
  amount: string
  onAmountChange: (value: string) => void
  hasStripeApiKey: boolean
  helperText?: string
}) {
  const pricingDisabled = !hasStripeApiKey
  const priceLabel =
    billingInterval === 'month'
      ? 'Monthly price (USD)'
      : billingInterval === 'year'
        ? 'Yearly price (USD)'
        : 'One-time price (USD)'
  const pricePlaceholder = billingInterval === 'month' ? '4.99' : billingInterval === 'year' ? '49.99' : '19.99'
  const priceSuffix = billingInterval === 'month' ? '/mo' : billingInterval === 'year' ? '/yr' : null

  return (
    <>
      {onBillingIntervalChange && billingInterval !== 'one_time' && (
        <div className="space-y-1.5">
          <Label>Billing interval</Label>
          <RadioGroup
            aria-label="Billing interval"
            value={billingInterval}
            onValueChange={(value: string) => onBillingIntervalChange(value as 'month' | 'year')}
            className="grid grid-cols-2 gap-2"
          >
            <Label
              htmlFor={`${idPrefix}-interval-month`}
              className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/50"
            >
              <RadioGroupItem id={`${idPrefix}-interval-month`} value="month" />
              Monthly
            </Label>
            <Label
              htmlFor={`${idPrefix}-interval-year`}
              className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/50"
            >
              <RadioGroupItem id={`${idPrefix}-interval-year`} value="year" />
              Yearly
            </Label>
          </RadioGroup>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-amount`}>{priceLabel}</Label>
        <InputGroup data-disabled={pricingDisabled || undefined}>
          <InputGroupAddon align="inline-start">
            <InputGroupText>$</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            id={`${idPrefix}-amount`}
            name="amount"
            type="number"
            inputMode="decimal"
            min="0.50"
            max="999999.99"
            step="0.01"
            required={!pricingDisabled}
            disabled={pricingDisabled}
            placeholder={pricePlaceholder}
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
          />
          {priceSuffix && (
            <InputGroupAddon align="inline-end">
              <InputGroupText>{priceSuffix}</InputGroupText>
            </InputGroupAddon>
          )}
        </InputGroup>
        {!hasStripeApiKey ? (
          <p className="text-xs text-muted-foreground">
            Connect your Stripe account in{' '}
            <Link to="/settings" hash="payment-credentials" className="underline underline-offset-4">
              Settings
            </Link>{' '}
            to create and sync plans with Stripe.
          </p>
        ) : (
          helperText && <p className="text-xs text-muted-foreground">{helperText}</p>
        )}
      </div>
    </>
  )
}

function PlansCard({ extension, billingMode }: { extension: Extension; billingMode: BillingMode }) {
  const queryClient = useQueryClient()
  const { data: plans = [] } = useQuery(plansQuery(extension.id))
  const { data: paymentCredentials = [] } = useQuery(paymentCredentialsQuery)
  const stripeCred = paymentCredentials.find((c) => c.provider === 'stripe')
  const hasStripeApiKey = Boolean(stripeCred?.connected || stripeCred?.stripeAccountId)
  const entitlementType: 'perpetual' | 'recurring' = billingMode === 'subscription' ? 'recurring' : 'perpetual'

  const [open, setOpen] = useState(false)
  // Prefills are suggestions the tenant confirms — never auto-created rows.
  const [tier, setTier] = useState('pro')
  const [maxActivations, setMaxActivations] = useState('3')
  const [interval, setInterval] = useState<'month' | 'year'>('month')
  const [amount, setAmount] = useState('')
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
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['extensions', extension.id, 'plans'] })
    },
    onError: (err) => setFormError(errorMessage(err)),
  })

  const togglePlanActive = useMutation({
    mutationFn: ({ planId, active }: { planId: string; active: boolean }) =>
      api<{ plan: Plan }>(`/api/v1/plans/${planId}`, {
        method: 'PATCH',
        body: JSON.stringify({ active }),
      }),
    onSuccess: ({ plan }) => {
      toast.success(
        plan.active
          ? `${plan.tier} (${formatBillingInterval(plan.billingInterval)}) enabled`
          : `${plan.tier} (${formatBillingInterval(plan.billingInterval)}) disabled for new checkouts`,
      )
      void queryClient.invalidateQueries({ queryKey: ['extensions', extension.id, 'plans'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!tier.trim()) return

    const normCurrency = 'usd'
    const billingInterval: BillingInterval = entitlementType === 'recurring' ? interval : 'one_time'

    const parsedAmount = parsePriceInput(amount, normCurrency)
    if (!parsedAmount.ok) {
      setFormError(parsedAmount.error)
      return
    }
    if (parsedAmount.value === null) {
      setFormError('Enter a price to sync with Stripe')
      return
    }

    const payload: Record<string, unknown> = {
      extensionId: extension.id,
      tier: tier.trim(),
      entitlementType,
      billingInterval,
      currency: normCurrency,
      amount: parsedAmount.value,
      ...(entitlementType === 'perpetual' ? { maxActivations: Number.parseInt(maxActivations, 10) || 3 } : {}),
    }
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
                  the Stripe Product and Price automatically.
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
                  billingInterval={entitlementType === 'recurring' ? interval : 'one_time'}
                  onBillingIntervalChange={entitlementType === 'recurring' ? setInterval : undefined}
                  amount={amount}
                  onAmountChange={setAmount}
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
            ? 'No subscription plans yet. Add a monthly or yearly plan to sync with Stripe.'
            : 'No license plans yet. Add a tier with a one-time price and device limit to start issuing codes.'}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tier</TableHead>
              {billingMode === 'subscription' && <TableHead>Interval</TableHead>}
              <TableHead>Pricing</TableHead>
              {billingMode === 'license' && <TableHead>Max devices</TableHead>}
              <TableHead>Stripe</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.map((plan) => (
              <TableRow key={plan.id} className={cn(!plan.active && 'opacity-60')}>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary">{plan.tier}</Badge>
                    {!plan.active && <Badge variant="outline">Disabled</Badge>}
                  </div>
                </TableCell>
                {billingMode === 'subscription' && (
                  <TableCell className="text-muted-foreground">{formatBillingInterval(plan.billingInterval)}</TableCell>
                )}
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
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={togglePlanActive.isPending}
                      aria-label={`${plan.active ? 'Disable' : 'Enable'} ${plan.tier} ${formatBillingInterval(plan.billingInterval).toLowerCase()} plan`}
                      onClick={() => togglePlanActive.mutate({ planId: plan.id, active: !plan.active })}
                    >
                      {plan.active ? 'Disable' : 'Enable'}
                    </Button>
                    <PlanEditDialog plan={plan} extensionId={extension.id} hasStripeApiKey={hasStripeApiKey} />
                  </div>
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
  const [amount, setAmount] = useState(formatMinorToInput(plan.amount, plan.currency))
  const [formError, setFormError] = useState<string | null>(null)

  const intervalLabel = formatBillingInterval(plan.billingInterval).toLowerCase()

  const syncFromPlan = () => {
    setMaxActivations(String(plan.maxActivations))
    setAmount(formatMinorToInput(plan.amount, plan.currency))
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

    const normCurrency = plan.currency.toLowerCase()

    const payload: Record<string, unknown> = {}
    if (plan.entitlementType === 'perpetual') {
      payload.maxActivations = Number.parseInt(maxActivations, 10) || plan.maxActivations
    }

    if (hasStripeApiKey) {
      const parsed = parsePriceInput(amount, normCurrency)
      if (!parsed.ok) {
        setFormError(parsed.error)
        return
      }
      if (parsed.value === null) {
        setFormError('Enter a price to sync with Stripe')
        return
      }
      if (parsed.value !== plan.amount) {
        payload.amount = parsed.value
        payload.currency = normCurrency
      }
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
        <Button variant="ghost" size="sm" aria-label={`Edit ${plan.tier} ${intervalLabel} plan`}>
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Edit {plan.tier} ({intervalLabel})
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
            billingInterval={plan.billingInterval}
            amount={amount}
            onAmountChange={setAmount}
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

export function SubscriptionPlanCell({ tier, billingInterval }: { tier: string; billingInterval?: BillingInterval }) {
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant="secondary">{tier}</Badge>
      {billingInterval && billingInterval !== 'one_time' && (
        <span className="text-xs text-muted-foreground">{billingInterval === 'year' ? 'yearly' : 'monthly'}</span>
      )}
    </div>
  )
}

export function SubscriptionStatusCell({ sub }: { sub: SubscriptionRow }) {
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
  } else if (sub.pendingPlan) {
    const targetInterval = sub.pendingPlan.billingInterval === 'year' ? 'yr' : 'mo'
    const eff = sub.pendingEffectiveAt ? formatDate(sub.pendingEffectiveAt) : periodEnd
    hint = `→ ${sub.pendingPlan.tier} (${targetInterval})${eff ? ` ${eff}` : ''}`
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
                  <SubscriptionPlanCell tier={sub.tier} billingInterval={sub.billingInterval} />
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
  const [showReleased, setShowReleased] = useState(false)
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
  const allActivations = detail.data?.activations ?? []
  const active = allActivations.filter((a) => !a.releasedAt)
  const released = allActivations.filter((a) => Boolean(a.releasedAt))
  const hasMetadata = row.entitlementType === 'recurring' || Boolean(row.externalUserId)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Devices
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
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
        ) : (
          <div className="space-y-3">
            {active.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No active devices — all {license.maxActivations} seats free.
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {active.length} of {license.maxActivations} seats in use. Idle seats free themselves after 30 days;
                  releasing one here is the manual escape hatch for a buyer who asks.
                </p>
                <ul className="space-y-2">
                  {active.map((device) => (
                    <li
                      key={device.id}
                      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                    >
                      <DeviceActivationInfo device={device} />
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
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
            {released.length > 0 && (
              <div className="border-t pt-2">
                <button
                  type="button"
                  aria-expanded={showReleased}
                  onClick={() => setShowReleased((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronDown className={cn('size-3.5 transition-transform', showReleased && 'rotate-180')} />
                  Released devices ({released.length})
                </button>
                {showReleased && (
                  <ul className="mt-2 space-y-2">
                    {released.map((device) => (
                      <li
                        key={device.id}
                        className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm opacity-75"
                      >
                        <DeviceActivationInfo device={device} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DeviceActivationInfo({ device }: { device: ActivationRow }) {
  const agent = parseDeviceAgent(device.uaHint)
  const shortFingerprint = `${device.deviceFingerprint.slice(0, 13)}…`

  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex flex-wrap items-center gap-x-1.5 text-sm">
        {agent.label ? (
          <span className="font-medium" title={device.uaHint ?? undefined}>
            {agent.label}
          </span>
        ) : (
          <code className="text-xs" title={device.deviceFingerprint}>
            {shortFingerprint}
          </code>
        )}
        {device.geoHint && (
          <>
            <span className="text-muted-foreground" aria-hidden>
              ·
            </span>
            <span className="text-muted-foreground">{device.geoHint}</span>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        {device.ipHint && <code className="font-mono">{device.ipHint}</code>}
        {device.ipHint && agent.label && <span aria-hidden>·</span>}
        {agent.label && (
          <code className="font-mono" title={device.deviceFingerprint}>
            {shortFingerprint}
          </code>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        activated {formatDate(device.activatedAt)}
        {device.releasedAt
          ? ` · released ${formatDate(device.releasedAt)}`
          : device.lastHeartbeatAt
            ? ` · last seen ${formatDate(device.lastHeartbeatAt)}`
            : ''}
      </p>
    </div>
  )
}
