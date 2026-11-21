import {
  api,
  ApiError,
  type ActivationRow,
  type EntitlementType,
  type Extension,
  type LicenseRow,
  type Plan,
} from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Section, sectionBodyClass, sectionEmptyClass } from '@/components/Section'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { licensesInfiniteQuery, plansQuery } from '@/queries'
import { formatDate } from '@/status'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

// The tenant-side licensing UI: plans (one row per tier + billing model),
// manual license issuance, and per-license device & subscription management
// including the seat release the buyer portal deliberately lacks. See docs/licensing.md.

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

/** amountTotal is Stripe's smallest currency unit; null for manual/imported rows not yet backfilled. */
export function formatAmount(amountTotal: number | null, currency: string | null): string {
  if (amountTotal === null || currency === null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(
    amountTotal / 100,
  )
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
    if (periodEnd && license.currentPeriodEnd) {
      hint = new Date(license.currentPeriodEnd).getTime() <= Date.now() ? `ended ${periodEnd}` : `until ${periodEnd}`
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
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/api/v1/extensions/${extension.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ licensingEnabled: enabled }),
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
            Sell activation codes or subscriptions for this extension: define a plan, sell via your Stripe Payment Link,
            and verify via @extport/sdk or the server-side entitlement API. Enabling only turns the public verification
            endpoints on — nothing changes for users until your extension ships licensing code.
          </>
        }
      >
        <div className={sectionBodyClass}>
          <Button onClick={() => toggle.mutate(true)} disabled={toggle.isPending}>
            Enable licensing
          </Button>
        </div>
      </Section>
    )
  }

  return (
    <div className="space-y-8">
      <PlansCard extension={extension} />
      <LicensesCard extension={extension} />
      <p className="text-sm text-muted-foreground">
        Licensing can be switched off at any time — already-activated devices keep their entitlement from local state,
        but new activations stop.{' '}
        <button className="underline underline-offset-4 hover:text-foreground" onClick={() => toggle.mutate(false)}>
          Disable licensing
        </button>
      </p>
    </div>
  )
}

function PlansCard({ extension }: { extension: Extension }) {
  const queryClient = useQueryClient()
  const { data: plans = [] } = useQuery(plansQuery(extension.id))
  const [open, setOpen] = useState(false)
  // Prefills are suggestions the tenant confirms — never auto-created rows.
  const [tier, setTier] = useState('pro')
  const [entitlementType, setEntitlementType] = useState<'perpetual' | 'recurring'>('perpetual')
  const [maxActivations, setMaxActivations] = useState('3')

  const add = useMutation({
    mutationFn: () =>
      api<{ plan: Plan }>('/api/v1/plans', {
        method: 'POST',
        body: JSON.stringify({
          extensionId: extension.id,
          tier: tier.trim(),
          entitlementType,
          maxActivations: Number.parseInt(maxActivations, 10) || 3,
        }),
      }),
    onSuccess: () => {
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['extensions', extension.id, 'plans'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Section
      title="Plans"
      action={
        <>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" aria-label="Add a plan">
                <Plus /> <span className="hidden sm:inline">Add a plan</span>
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add a plan</DialogTitle>
              </DialogHeader>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (tier.trim()) add.mutate()
                }}
              >
                <p className="text-xs text-muted-foreground">
                  A plan belongs to this extension — licenses verify against its id (<code>ext_…</code>), which is
                  fixed; pricing and billing intervals stay in Stripe.
                </p>
                <div className="space-y-1">
                  <Label htmlFor="plan-tier">Tier</Label>
                  <Input id="plan-tier" name="tier" required value={tier} onChange={(e) => setTier(e.target.value)} />
                  <span className="block text-xs text-muted-foreground">
                    The tier the SDK resolves (e.g. <code>pro</code>). One plan per (tier, billing model);{' '}
                    <code>free</code> is reserved.
                  </span>
                </div>
                <fieldset className="space-y-1.5">
                  <legend className="text-sm font-medium">Billing model</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex items-start gap-2 rounded-md border p-2.5 text-sm">
                      <input
                        id="plan-type-perpetual"
                        name="entitlementType"
                        type="radio"
                        value="perpetual"
                        checked={entitlementType === 'perpetual'}
                        onChange={() => setEntitlementType('perpetual')}
                        className="mt-0.5 accent-primary"
                      />
                      <label htmlFor="plan-type-perpetual" className="cursor-pointer space-y-0.5">
                        <span className="block font-medium">One-time</span>
                        <span className="block text-xs text-muted-foreground">Perpetual license</span>
                      </label>
                    </div>
                    <div className="flex items-start gap-2 rounded-md border p-2.5 text-sm">
                      <input
                        id="plan-type-recurring"
                        name="entitlementType"
                        type="radio"
                        value="recurring"
                        checked={entitlementType === 'recurring'}
                        onChange={() => setEntitlementType('recurring')}
                        className="mt-0.5 accent-primary"
                      />
                      <label htmlFor="plan-type-recurring" className="cursor-pointer space-y-0.5">
                        <span className="block font-medium">Subscription</span>
                        <span className="block text-xs text-muted-foreground">Recurring via Stripe</span>
                      </label>
                    </div>
                  </div>
                </fieldset>
                <div className="space-y-1">
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
                <Button type="submit" disabled={add.isPending}>
                  Create plan
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </>
      }
    >
      {plans.length === 0 ? (
        <p className={sectionEmptyClass}>
          No plans yet. A plan is what a license is sold for — a (product, tier) pair with its billing model and device
          limit. Create one to start issuing codes.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tier</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Max devices</TableHead>
              <TableHead>Stripe metadata</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.map((plan) => (
              <TableRow key={plan.id}>
                <TableCell>
                  <Badge variant="secondary">{plan.tier}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{formatEntitlementLabel(plan.entitlementType)}</Badge>
                </TableCell>
                <TableCell>{plan.maxActivations}</TableCell>
                <TableCell>
                  <code className="text-xs text-muted-foreground">extport_plan={plan.id}</code>
                </TableCell>
                <TableCell>
                  <PlanEditDialog plan={plan} extensionId={extension.id} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}

function PlanEditDialog({ plan, extensionId }: { plan: Plan; extensionId: string }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [maxActivations, setMaxActivations] = useState(String(plan.maxActivations))

  const save = useMutation({
    mutationFn: () =>
      api<{ plan: Plan }>(`/api/v1/plans/${plan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ maxActivations: Number.parseInt(maxActivations, 10) || plan.maxActivations }),
      }),
    onSuccess: () => {
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['extensions', extensionId, 'plans'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Edit {plan.tier} ({formatEntitlementLabel(plan.entitlementType)})
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
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
          <p className="text-xs text-muted-foreground">
            Tier can't be edited after issuance: installed extensions resolve the tier from their local copy of the
            SDK's tier table, so renaming one would fail every existing device's check. Selling something different?
            Create a new plan.
          </p>
          <Button type="submit" disabled={save.isPending}>
            Save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LicensesCard({ extension }: { extension: Extension }) {
  const queryClient = useQueryClient()
  const { data: plans = [] } = useQuery(plansQuery(extension.id))
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
