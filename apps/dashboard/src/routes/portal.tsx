import { ApiError, api } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
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

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Your purchases</h1>
          {licenses.data && (
            <p className="text-sm text-muted-foreground">{licenses.data.email}</p>
          )}
        </div>
        {licenses.data && (
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        )}
      </header>

      {code || verify.isPending ? (
        <Card>
          <CardHeader>
            <CardTitle>Signing you in…</CardTitle>
          </CardHeader>
        </Card>
      ) : licenses.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : licenses.data ? (
        <LicenseList licenses={licenses.data.licenses} />
      ) : (
        <SignInCard />
      )}
    </main>
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
      <Card>
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            If there are purchases under {email}, a sign-in link is on its way. It's valid for 15 minutes.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          Enter the email you used at checkout and we'll send you a sign-in link — no password needed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (email.trim()) request.mutate(email.trim())
          }}
        >
          <Input
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" disabled={request.isPending}>
            Send link
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
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">
                {license.productName} <Badge variant="secondary">{license.tier}</Badge>
              </CardTitle>
              {license.status !== 'active' && <Badge variant="destructive">{license.status}</Badge>}
            </div>
            <CardDescription>
              Purchased {new Date(license.createdAt).toLocaleDateString()} · up to {license.maxActivations} devices
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <code className="block rounded-md border bg-muted px-4 py-2 font-mono tracking-wider">{license.key}</code>
            <Devices devices={license.devices} />
            <p className="text-xs text-muted-foreground">
              Idle devices free their seat automatically after 30 days. Need a seat released sooner? Contact the
              developer of the extension.
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function Devices({ devices }: { devices: PortalDevice[] }) {
  const active = devices.filter((d) => !d.releasedAt)
  if (active.length === 0) return <p className="text-sm text-muted-foreground">No active devices.</p>
  return (
    <ul className="space-y-1 text-sm">
      {active.map((device) => (
        <li key={device.fingerprint} className="flex items-center justify-between text-muted-foreground">
          <span className="font-mono">{device.fingerprint.slice(0, 8)}…</span>
          <span>
            active since {new Date(device.activatedAt).toLocaleDateString()}
            {device.lastHeartbeatAt ? ` · last seen ${new Date(device.lastHeartbeatAt).toLocaleDateString()}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
