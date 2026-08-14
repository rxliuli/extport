import { api, ApiError, type ActivationRow, type Extension, type LicenseRow, type Plan } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/extra/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { licensesInfiniteQuery, plansQuery } from '@/queries'
import { formatDate } from '@/status'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

// The tenant-side licensing UI: plans (one row per tier), manual license
// issuance, and per-license device management including the seat release
// the buyer portal deliberately lacks. See docs/licensing.md.

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

/** amountTotal is Stripe's smallest currency unit; null for manual/imported rows not yet backfilled. */
export function formatAmount(amountTotal: number | null, currency: string | null): string {
  if (amountTotal === null || currency === null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amountTotal / 100)
}

export function LicensingSection({ extension }: { extension: Extension }) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/api/v1/extensions/${extension.id}`, { method: 'PATCH', body: JSON.stringify({ licensingEnabled: enabled }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['extensions'] }),
    onError: (err) => toast.error(errorMessage(err)),
  })

  if (!extension.licensingEnabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Licensing is off</CardTitle>
          <CardDescription>
            Sell activation codes for this extension: define a plan, issue codes manually or through your Stripe
            Payment Link, and let the extension verify them via @extport/sdk. Enabling only turns the public
            verification endpoints on — nothing changes for users until your extension ships licensing code.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => toggle.mutate(true)} disabled={toggle.isPending}>
            Enable licensing
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <PlansCard extension={extension} />
      <LicensesCard extension={extension} />
      <p className="text-sm text-muted-foreground">
        Licensing can be switched off at any time — already-activated devices keep their entitlement from local
        state, but new activations stop.{' '}
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
  const [maxActivations, setMaxActivations] = useState('3')

  const add = useMutation({
    mutationFn: () =>
      api<{ plan: Plan }>('/api/v1/plans', {
        method: 'POST',
        body: JSON.stringify({
          extensionId: extension.id,
          tier: tier.trim(),
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
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Plans</CardTitle>
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
                The <code>productName</code> your extension passes to @extport/sdk is this extension's name
                (<span className="font-medium">{extension.name}</span>) — it stays locked while licensing is enabled.
              </p>
              <label className="text-sm font-medium">
                Tier
                <Input className="mt-1" value={tier} onChange={(e) => setTier(e.target.value)} />
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  The tier the SDK resolves (e.g. <code>pro</code>). One plan per tier; <code>free</code> is reserved.
                </span>
              </label>
              <label className="text-sm font-medium">
                Max devices per license
                <Input
                  className="mt-1"
                  type="number"
                  min={1}
                  max={100}
                  value={maxActivations}
                  onChange={(e) => setMaxActivations(e.target.value)}
                />
              </label>
              <Button type="submit" disabled={add.isPending}>
                Create plan
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No plans yet. A plan is what a license is sold for — a (product, tier) pair with its device limit. Create
            one to start issuing codes.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tier</TableHead>
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
      </CardContent>
    </Card>
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
            Edit {plan.tier}
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <label className="text-sm font-medium">
            Max devices per license
            <Input
              className="mt-1"
              type="number"
              min={1}
              max={100}
              value={maxActivations}
              onChange={(e) => setMaxActivations(e.target.value)}
            />
            <span className="mt-1 block text-xs font-normal text-muted-foreground">
              Applies to licenses issued from now on — already-sold licenses keep the limit they were sold with.
            </span>
          </label>
          <p className="text-xs text-muted-foreground">
            Name and tier can't be edited: installed extensions carry them as their verification contract
            (<code>productName</code> and the SDK's tier table), so changing either would fail every existing
            device's check. Selling something different? Create a new plan.
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

  const selectedPlanId = planById.has(planId) ? planId : (plans[0]?.id ?? '')

  const issue = useMutation({
    mutationFn: () =>
      api<{ license: LicenseRow }>('/api/v1/licenses', {
        method: 'POST',
        body: JSON.stringify({ planId: selectedPlanId, buyerEmail: buyerEmail.trim() }),
      }),
    onSuccess: ({ license }) => {
      setOpen(false)
      setBuyerEmail('')
      toast.success(`Issued ${license.key}`)
      void queryClient.invalidateQueries({ queryKey: ['licenses'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Licenses</CardTitle>
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
                <label className="text-sm font-medium">
                  Plan
                  <Select value={selectedPlanId} onValueChange={setPlanId}>
                    <SelectTrigger className="mt-1 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {plans.map((plan) => (
                        <SelectItem key={plan.id} value={plan.id}>
                          {plan.tier}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="text-sm font-medium">
                  Buyer email
                  <Input
                    className="mt-1"
                    type="email"
                    placeholder="buyer@example.com"
                    value={buyerEmail}
                    onChange={(e) => setBuyerEmail(e.target.value)}
                  />
                </label>
                <Button type="submit" disabled={issue.isPending}>
                  Issue
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent>
        {licenses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No licenses yet. They appear here as your Stripe webhook fulfills purchases, or when you issue one
            manually.
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
                    <Badge variant="secondary">{license.tier}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{license.buyerEmail}</TableCell>
                  <TableCell className="text-muted-foreground">{formatAmount(license.amountTotal, license.currency)}</TableCell>
                  <TableCell>
                    {license.status === 'active' ? (
                      <span className="text-muted-foreground">active</span>
                    ) : (
                      <Badge variant="destructive">{license.status}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{license.source.replace('_webhook', '')}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(license.createdAt)}
                  </TableCell>
                  <TableCell>
                    <DevicesDialog license={license} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {licensesPages.hasNextPage && (
          <div className="mt-3 flex justify-center">
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
      </CardContent>
    </Card>
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

  const active = (detail.data?.activations ?? []).filter((a) => !a.releasedAt)

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
                      {device.lastHeartbeatAt
                        ? ` · last seen ${formatDate(device.lastHeartbeatAt)}`
                        : ''}
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
