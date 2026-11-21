import {
  ApiError,
  api,
  isSafeHttpUrl,
  type BillingInterval,
  type EntitlementType,
  type SubscriptionStatus,
} from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/extra/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { PortalShell } from '@/PortalShell'
import { formatDate } from '@/status'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Check, ChevronDown, Copy, CreditCard, LifeBuoy, Loader2, MailCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

// The buyer portal (canonically portal.extport.dev): magic-link sign-in
// by the purchase email, then a read-only list of every license under it.
// Deliberately no self-service seat release — see docs/licensing.md.

interface PortalDevice {
  fingerprint: string
  activatedAt: string
  lastHeartbeatAt: string | null
  releasedAt: string | null
}

interface PortalLicense {
  key: string
  status: 'active' | 'locked' | 'refunded'
  entitlementType: EntitlementType
  subscriptionStatus: SubscriptionStatus | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  externalUserId: string | null
  maxActivations: number
  createdAt: string
  productName: string
  tier: string
  /** The selling developer's help link (page or mailto:), if they set one. */
  supportUrl: string | null
  /** The selling developer's Stripe Customer Portal link, if they set one. */
  billingPortalUrl: string | null
  /** True when one-click Billing Portal or static billingPortalUrl is available. */
  canManageBilling?: boolean
  devices: PortalDevice[]
}

interface PortalSubscription {
  id: string
  status: SubscriptionStatus
  billingInterval?: BillingInterval
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  externalUserId: string | null
  createdAt: string
  productName: string
  tier: string
  supportUrl: string | null
  billingPortalUrl: string | null
  canManageBilling?: boolean
  canCancel?: boolean
}

function isPortalSubscriptionEntitled(sub: PortalSubscription): boolean {
  if (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due') return true
  if (sub.status === 'canceled' && sub.currentPeriodEnd) {
    return new Date(sub.currentPeriodEnd).getTime() > Date.now()
  }
  return false
}

function isPortalLicenseEntitled(license: PortalLicense): boolean {
  if (license.status !== 'active') return false
  if (license.entitlementType !== 'recurring') return true
  if (
    license.subscriptionStatus === 'active' ||
    license.subscriptionStatus === 'trialing' ||
    license.subscriptionStatus === 'past_due'
  ) {
    return true
  }
  if (license.subscriptionStatus === 'canceled' && license.currentPeriodEnd) {
    return new Date(license.currentPeriodEnd).getTime() > Date.now()
  }
  return false
}

export const Route = createFileRoute('/portal')({
  validateSearch: (search): { code?: string } => ({
    code: typeof search.code === 'string' ? search.code : undefined,
  }),
  component: PortalPage,
})

function PortalPage() {
  const { code } = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const licenses = useQuery({
    queryKey: ['portal-licenses'],
    queryFn: async () => {
      try {
        return await api<{ email: string; licenses: PortalLicense[]; subscriptions?: PortalSubscription[] }>(
          '/api/v1/portal/licenses',
        )
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null
        throw err
      }
    },
    // A magic-link code in the URL is about to be exchanged — don't flash
    // the signed-out form in the meantime.
    enabled: !code,
  })

  const verify = useMutation({
    mutationFn: (magicCode: string) =>
      api<{ email: string }>('/api/v1/portal/verify', { method: 'POST', body: JSON.stringify({ code: magicCode }) }),
    onSettled: async () => {
      // Strip the single-use code from the URL either way.
      await navigate({ to: '/portal', search: {}, replace: true })
      await queryClient.invalidateQueries({ queryKey: ['portal-licenses'] })
    },
    onError: () => {
      toast.error('That sign-in link is invalid or has expired — request a new one below.')
    },
  })

  useEffect(() => {
    if (code) verify.mutate(code)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  const signOut = async () => {
    await api('/api/v1/portal/logout', { method: 'POST' })
    await queryClient.invalidateQueries({ queryKey: ['portal-licenses'] })
  }

  const busy = Boolean(code) || verify.isPending || licenses.isLoading

  if (busy) {
    return (
      <PortalShell>
        <main className="flex flex-1 items-center justify-center p-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {code || verify.isPending ? 'Signing you in…' : 'Loading…'}
          </div>
        </main>
      </PortalShell>
    )
  }

  if (!licenses.data) {
    return (
      <PortalShell>
        <main className="flex flex-1 items-center justify-center p-6">
          <SignInCard />
        </main>
      </PortalShell>
    )
  }

  return (
    <PortalShell
      actions={
        <>
          <span className="text-sm text-muted-foreground">{licenses.data.email}</span>
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </>
      }
    >
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight">Your purchases</h1>
        <PurchasesList licenses={licenses.data.licenses} subscriptions={licenses.data.subscriptions ?? []} />
      </main>
    </PortalShell>
  )
}

function SignInCard() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const request = useMutation({
    mutationFn: (address: string) =>
      api<{ ok: boolean }>('/api/v1/portal/request-link', { method: 'POST', body: JSON.stringify({ email: address }) }),
    onSuccess: () => setSent(true),
  })

  if (sent) {
    return (
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <MailCheck className="mx-auto size-10 text-muted-foreground" />
          <CardTitle className="text-xl">Check your email</CardTitle>
          <CardDescription>
            If there are purchases under <span className="font-medium text-foreground">{email}</span>, a sign-in link is
            on its way. It's valid for 15 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="ghost" size="sm" className="w-full" onClick={() => setSent(false)}>
            Use a different email
          </Button>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl tracking-tight">Your purchases</CardTitle>
        <CardDescription>
          Enter the email you used at checkout and we'll send you a sign-in link — no password needed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (email.trim()) request.mutate(email.trim())
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="portal-email">Email</Label>
            <Input
              id="portal-email"
              type="email"
              required
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={request.isPending}>
            {request.isPending && <Loader2 className="animate-spin" />}
            Email me a sign-in link
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function PurchasesList({
  licenses,
  subscriptions,
}: {
  licenses: PortalLicense[]
  subscriptions: PortalSubscription[]
}) {
  if (licenses.length === 0 && subscriptions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No purchases yet</CardTitle>
          <CardDescription>Nothing is registered under this email address.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const orderedSubs = [
    ...subscriptions.filter((s) => isPortalSubscriptionEntitled(s)),
    ...subscriptions.filter((s) => !isPortalSubscriptionEntitled(s)),
  ]
  const orderedLicenses = [
    ...licenses.filter((l) => isPortalLicenseEntitled(l)),
    ...licenses.filter((l) => !isPortalLicenseEntitled(l)),
  ]

  return (
    <div className="space-y-6">
      {orderedSubs.length > 0 && (
        <section className="space-y-2.5">
          {orderedLicenses.length > 0 && <h2 className="text-sm font-medium text-muted-foreground">Subscriptions</h2>}
          <ul className="divide-y rounded-xl border bg-card text-card-foreground shadow-sm">
            {orderedSubs.map((sub) => (
              <SubscriptionItemRow key={sub.id} subscription={sub} />
            ))}
          </ul>
        </section>
      )}
      {orderedLicenses.length > 0 && (
        <section className="space-y-2.5">
          {orderedSubs.length > 0 && <h2 className="text-sm font-medium text-muted-foreground">Licenses</h2>}
          <ul className="divide-y rounded-xl border bg-card text-card-foreground shadow-sm">
            {orderedLicenses.map((license) => (
              <LicenseRow key={license.key} license={license} />
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Idle devices free their seat automatically after 30 days. Need a seat released sooner?{' '}
            {licenses.some((l) => l.supportUrl)
              ? 'Use Get help on that purchase to reach its developer.'
              : 'Contact the developer of the extension.'}
          </p>
        </section>
      )}
    </div>
  )
}

function SubscriptionItemRow({ subscription }: { subscription: PortalSubscription }) {
  const queryClient = useQueryClient()
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false)
  const entitled = isPortalSubscriptionEntitled(subscription)
  const inactive = !entitled
  const end = subscription.currentPeriodEnd ? formatDate(subscription.currentPeriodEnd) : null
  let periodNote: string | null = null
  if (subscription.status === 'expired') {
    periodNote =
      end && subscription.currentPeriodEnd && new Date(subscription.currentPeriodEnd).getTime() <= Date.now()
        ? `Ended ${end}`
        : 'Expired'
  } else if (subscription.status === 'canceled' || subscription.cancelAtPeriodEnd) {
    periodNote = end ? `Ends ${end}` : 'Cancels at period end'
  } else if (subscription.status === 'trialing') {
    periodNote = end ? `Trial ends ${end}` : 'Trialing'
  } else if (subscription.status === 'past_due') {
    periodNote = end ? `Payment past due (${end})` : 'Payment past due'
  } else if (end) {
    periodNote = `Renews ${end}`
  }

  const canModify =
    Boolean(subscription.canCancel) &&
    (subscription.status === 'active' || subscription.status === 'trialing' || subscription.status === 'past_due')

  const cancelSub = useMutation({
    mutationFn: () =>
      api(`/api/v1/portal/subscriptions/${subscription.id}/cancel`, {
        method: 'POST',
      }),
    onSuccess: () => {
      setConfirmCancelOpen(false)
      toast.success(
        end ? `Subscription will end on ${end}` : 'Subscription will cancel at the end of the billing period',
      )
      void queryClient.invalidateQueries({ queryKey: ['portal-licenses'] })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : String(err)),
  })

  const resumeSub = useMutation({
    mutationFn: () =>
      api(`/api/v1/portal/subscriptions/${subscription.id}/resume`, {
        method: 'POST',
      }),
    onSuccess: () => {
      toast.success('Subscription resumed')
      void queryClient.invalidateQueries({ queryKey: ['portal-licenses'] })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : String(err)),
  })

  const showManageBilling = subscription.canManageBilling ?? isSafeHttpUrl(subscription.billingPortalUrl)
  const manageBilling = useMutation({
    mutationFn: () =>
      api<{ url: string }>('/api/v1/portal/billing-portal', {
        method: 'POST',
        body: JSON.stringify({ subscriptionId: subscription.id }),
      }),
    onSuccess: ({ url }) => {
      if (isSafeHttpUrl(url)) {
        window.location.assign(url)
      } else if (isSafeHttpUrl(subscription.billingPortalUrl)) {
        window.location.assign(subscription.billingPortalUrl)
      } else {
        toast.error('Billing portal is unavailable for this subscription')
      }
    },
    onError: (err) => {
      if (isSafeHttpUrl(subscription.billingPortalUrl)) {
        window.location.assign(subscription.billingPortalUrl)
        return
      }
      toast.error(err instanceof ApiError ? err.message : String(err))
    },
  })

  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className={cn('min-w-0 space-y-1', inactive && 'opacity-60')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{subscription.productName}</span>
            <Badge variant="secondary">{subscription.tier}</Badge>
            {subscription.billingInterval === 'month' && <Badge variant="outline">Monthly</Badge>}
            {subscription.billingInterval === 'year' && <Badge variant="outline">Yearly</Badge>}
            <Badge
              variant={
                subscription.status === 'expired' || subscription.status === 'past_due' ? 'destructive' : 'outline'
              }
            >
              {subscription.cancelAtPeriodEnd && subscription.status === 'active'
                ? 'canceling'
                : subscription.status.replace('_', ' ')}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>Subscribed {formatDate(subscription.createdAt)}</span>
            {periodNote && (
              <>
                <span aria-hidden>·</span>
                <span>{periodNote}</span>
              </>
            )}
            {subscription.supportUrl && (
              <>
                <span aria-hidden>·</span>
                <a
                  href={subscription.supportUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
                >
                  <LifeBuoy className="size-3" />
                  Get help
                </a>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canModify &&
            (subscription.cancelAtPeriodEnd ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={resumeSub.isPending}
                onClick={() => resumeSub.mutate()}
              >
                {resumeSub.isPending && <Loader2 className="size-3.5 animate-spin" />}
                Resume
              </Button>
            ) : (
              <Dialog open={confirmCancelOpen} onOpenChange={setConfirmCancelOpen}>
                <DialogTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    Cancel
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Cancel {subscription.productName} subscription?</DialogTitle>
                    <DialogDescription>
                      {end
                        ? `You'll keep access to ${subscription.tier} features through ${end}. You can resume your subscription anytime before then.`
                        : `You'll keep access to ${subscription.tier} features until the end of your current billing period. You can resume anytime before then.`}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => setConfirmCancelOpen(false)}>
                      Keep subscription
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={cancelSub.isPending}
                      onClick={() => cancelSub.mutate()}
                    >
                      {cancelSub.isPending && <Loader2 className="size-3.5 animate-spin" />}
                      Cancel at period end
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ))}
          {showManageBilling && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={manageBilling.isPending}
              aria-label={`Payment and invoices for ${subscription.productName}`}
              onClick={() => manageBilling.mutate()}
            >
              {manageBilling.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CreditCard className="size-3.5" />
              )}
              Payment & invoices
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}

function subscriptionPeriodNote(license: PortalLicense): string | null {
  if (license.entitlementType !== 'recurring') return null
  const end = license.currentPeriodEnd ? formatDate(license.currentPeriodEnd) : null
  if (license.subscriptionStatus === 'expired') {
    if (!end || !license.currentPeriodEnd) return 'Expired'
    return new Date(license.currentPeriodEnd).getTime() <= Date.now() ? `Ended ${end}` : `Expired`
  }
  if (license.subscriptionStatus === 'canceled' || license.cancelAtPeriodEnd) {
    return end ? `Ends ${end}` : 'Cancels at period end'
  }
  if (license.subscriptionStatus === 'trialing') return end ? `Trial ends ${end}` : 'Trialing'
  if (license.subscriptionStatus === 'past_due') return end ? `Payment past due (${end})` : 'Payment past due'
  return end ? `Renews ${end}` : null
}

function LicenseRow({ license }: { license: PortalLicense }) {
  const [showDevices, setShowDevices] = useState(false)
  const active = license.devices.filter((d) => !d.releasedAt)
  const entitled = isPortalLicenseEntitled(license)
  const inactive = !entitled
  const usage = `${active.length} of ${license.maxActivations} devices in use`
  const periodNote = subscriptionPeriodNote(license)
  const showManageBilling =
    license.entitlementType === 'recurring' && (license.canManageBilling ?? isSafeHttpUrl(license.billingPortalUrl))

  const manageBilling = useMutation({
    mutationFn: () =>
      api<{ url: string }>('/api/v1/portal/billing-portal', {
        method: 'POST',
        body: JSON.stringify({ key: license.key }),
      }),
    onSuccess: ({ url }) => {
      if (isSafeHttpUrl(url)) {
        window.location.assign(url)
      } else if (isSafeHttpUrl(license.billingPortalUrl)) {
        window.location.assign(license.billingPortalUrl)
      } else {
        toast.error('Billing portal is unavailable for this subscription')
      }
    },
    onError: (err) => {
      if (isSafeHttpUrl(license.billingPortalUrl)) {
        window.location.assign(license.billingPortalUrl)
        return
      }
      toast.error(err instanceof ApiError ? err.message : String(err))
    },
  })

  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className={cn('min-w-0 space-y-1', inactive && 'opacity-60')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{license.productName}</span>
            <Badge variant="secondary">{license.tier}</Badge>
            {license.entitlementType === 'recurring' && (
              <Badge
                variant={
                  license.status !== 'active' ||
                  license.subscriptionStatus === 'expired' ||
                  license.subscriptionStatus === 'past_due'
                    ? 'destructive'
                    : 'outline'
                }
              >
                {license.status !== 'active'
                  ? license.status
                  : license.cancelAtPeriodEnd && license.subscriptionStatus === 'active'
                    ? 'canceling'
                    : (license.subscriptionStatus?.replace('_', ' ') ?? 'subscription')}
              </Badge>
            )}
            {license.entitlementType !== 'recurring' && inactive && (
              <Badge variant="destructive">{license.status}</Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>
              {license.entitlementType === 'recurring' ? 'Subscribed' : 'Purchased'} {formatDate(license.createdAt)}
            </span>
            {periodNote && (
              <>
                <span aria-hidden>·</span>
                <span>{periodNote}</span>
              </>
            )}
            <span aria-hidden>·</span>
            {active.length > 0 ? (
              <button
                type="button"
                className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline"
                aria-expanded={showDevices}
                onClick={() => setShowDevices((v) => !v)}
              >
                {usage}
                <ChevronDown className={cn('size-3 transition-transform', showDevices && 'rotate-180')} />
              </button>
            ) : (
              <span>{usage}</span>
            )}
            {showManageBilling && (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  disabled={manageBilling.isPending}
                  aria-label={`Manage subscription for ${license.productName}`}
                  onClick={() => manageBilling.mutate()}
                  className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
                >
                  {manageBilling.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <CreditCard className="size-3" />
                  )}
                  Manage subscription
                </button>
              </>
            )}
            {license.supportUrl && (
              <>
                <span aria-hidden>·</span>
                <a
                  href={license.supportUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
                >
                  <LifeBuoy className="size-3" />
                  Get help
                </a>
              </>
            )}
          </div>
        </div>
        <KeyRow value={license.key} muted={inactive} />
      </div>
      {showDevices && <Devices devices={active} />}
    </li>
  )
}

function KeyRow({ value, muted }: { value: string; muted?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="flex shrink-0 items-center gap-2">
      <code
        className={cn(
          'flex-1 rounded-md border bg-muted px-2.5 py-1.5 font-mono text-sm tracking-wider sm:flex-none',
          muted && 'text-muted-foreground line-through',
        )}
      >
        {value}
      </code>
      <Button variant="outline" size="icon-sm" onClick={() => void copy()} aria-label="Copy activation code">
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}

function Devices({ devices }: { devices: PortalDevice[] }) {
  return (
    <ul className="mt-3 divide-y rounded-md border text-sm">
      {devices.map((device) => (
        <li
          key={device.fingerprint}
          className="flex flex-col gap-0.5 px-3 py-2 text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-3"
        >
          <span className="font-mono text-xs">{device.fingerprint.slice(0, 8)}…</span>
          <span className="text-xs">
            active since {formatDate(device.activatedAt)}
            {device.lastHeartbeatAt ? ` · last seen ${formatDate(device.lastHeartbeatAt)}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
