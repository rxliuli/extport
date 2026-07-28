import { ApiError, api } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { PortalShell } from '@/PortalShell'
import { formatDate } from '@/status'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Check, Copy, Loader2, MailCheck } from 'lucide-react'
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
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-6 py-8">
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
  return (
    <div className="space-y-4">
      {licenses.map((license) => (
        <Card key={license.key}>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-lg">
                {license.productName} <Badge variant="secondary">{license.tier}</Badge>
              </CardTitle>
              {license.status !== 'active' && <Badge variant="destructive">{license.status}</Badge>}
            </div>
            <CardDescription>
              Purchased {formatDate(license.createdAt)} · {activeCount(license)} of{' '}
              {license.maxActivations} devices in use
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <KeyRow value={license.key} />
            <Devices devices={license.devices} />
          </CardContent>
        </Card>
      ))}
      <p className="text-xs text-muted-foreground">
        Idle devices free their seat automatically after 30 days. Need a seat released sooner? Contact the developer
        of the extension.
      </p>
    </div>
  )
}

function activeCount(license: PortalLicense): number {
  return license.devices.filter((d) => !d.releasedAt).length
}

function KeyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 rounded-md border bg-muted px-3 py-2 font-mono tracking-wider">{value}</code>
      <Button variant="outline" size="icon" onClick={() => void copy()} aria-label="Copy activation code">
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}

function Devices({ devices }: { devices: PortalDevice[] }) {
  const active = devices.filter((d) => !d.releasedAt)
  if (active.length === 0) return null
  return (
    <ul className="divide-y rounded-md border text-sm">
      {active.map((device) => (
        <li key={device.fingerprint} className="flex items-center justify-between px-3 py-2 text-muted-foreground">
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
