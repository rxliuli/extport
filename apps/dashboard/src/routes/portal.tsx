import { ApiError, api } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/extra/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { PortalShell } from '@/PortalShell'
import { formatDate } from '@/status'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Check, ChevronDown, Copy, LifeBuoy, Loader2, MailCheck } from 'lucide-react'
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
  maxActivations: number
  createdAt: string
  productName: string
  tier: string
  /** The selling developer's help link (page or mailto:), if they set one. */
  supportUrl: string | null
  devices: PortalDevice[]
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
        return await api<{ email: string; licenses: PortalLicense[] }>('/api/v1/portal/licenses')
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
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight">Your purchases</h1>
        <LicenseList licenses={licenses.data.licenses} />
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
            If there are purchases under <span className="font-medium text-foreground">{email}</span>, a sign-in link
            is on its way. It's valid for 15 minutes.
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

function LicenseList({ licenses }: { licenses: PortalLicense[] }) {
  if (licenses.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No purchases yet</CardTitle>
          <CardDescription>Nothing is registered under this email address.</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  // The server sends newest first; codes that still work stay on top,
  // refunded/locked ones sink to the bottom (order within each kept).
  const ordered = [...licenses.filter((l) => l.status === 'active'), ...licenses.filter((l) => l.status !== 'active')]
  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-xl border bg-card text-card-foreground shadow-sm">
        {ordered.map((license) => (
          <LicenseRow key={license.key} license={license} />
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Idle devices free their seat automatically after 30 days. Need a seat released sooner?{' '}
        {licenses.some((l) => l.supportUrl)
          ? 'Use Get help on that purchase to reach its developer.'
          : 'Contact the developer of the extension.'}
      </p>
    </div>
  )
}

function LicenseRow({ license }: { license: PortalLicense }) {
  const [showDevices, setShowDevices] = useState(false)
  const active = license.devices.filter((d) => !d.releasedAt)
  const inactive = license.status !== 'active'
  const usage = `${active.length} of ${license.maxActivations} devices in use`
  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className={cn('min-w-0 space-y-1', inactive && 'opacity-60')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{license.productName}</span>
            <Badge variant="secondary">{license.tier}</Badge>
            {inactive && <Badge variant="destructive">{license.status}</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>Purchased {formatDate(license.createdAt)}</span>
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
