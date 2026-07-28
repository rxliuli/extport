import { ApiError, api } from '@/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

// Payment Links redirect here with ?session_id={CHECKOUT_SESSION_ID}.
// The redirect always beats the webhook, so this page polls until the
// fulfilled license appears (server truth only — the session id is just
// a lookup key). See docs/licensing.md.

interface Purchase {
  key: string
  productName: string
  tier: string
  maxActivations: number
  buyerEmail: string
  createdAt: string
}

type LookupState = { state: 'ready'; purchase: Purchase } | { state: 'pending' } | { state: 'expired' }

const POLL_MS = 2500
const GIVE_UP_MS = 90 * 1000

export const Route = createFileRoute('/purchase/success')({
  validateSearch: (search): { session_id?: string } => ({
    session_id: typeof search.session_id === 'string' ? search.session_id : undefined,
  }),
  component: PurchaseSuccessPage,
})

function PurchaseSuccessPage() {
  const { session_id: sessionId } = Route.useSearch()
  const [startedAt] = useState(() => Date.now())

  const lookup = useQuery({
    queryKey: ['portal-purchase', sessionId],
    enabled: Boolean(sessionId),
    queryFn: async (): Promise<LookupState> => {
      try {
        const body = await api<{ purchase: Purchase }>(`/api/v1/portal/purchase/${sessionId}`)
        return { state: 'ready', purchase: body.purchase }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return { state: 'pending' }
        if (err instanceof ApiError && err.status === 410) return { state: 'expired' }
        throw err
      }
    },
    refetchInterval: (query) => (query.state.data?.state === 'pending' ? POLL_MS : false),
  })

  const timedOut = lookup.data?.state === 'pending' && Date.now() - startedAt > GIVE_UP_MS

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        {!sessionId ? (
          <CardHeader>
            <CardTitle className="text-2xl tracking-tight">Missing purchase reference</CardTitle>
            <CardDescription>
              This page is reached from the checkout confirmation. If you just bought something, your activation code
              is also on its way to your email.
            </CardDescription>
          </CardHeader>
        ) : lookup.data?.state === 'ready' ? (
          <ReadyCard purchase={lookup.data.purchase} />
        ) : lookup.data?.state === 'expired' ? (
          <CardHeader>
            <CardTitle className="text-2xl tracking-tight">Check your email</CardTitle>
            <CardDescription>
              This confirmation link has expired. Your activation code was sent to your email at purchase time — you
              can also sign in to <Link to="/portal" className="underline">your purchases</Link> with that address to
              see it any time.
            </CardDescription>
          </CardHeader>
        ) : timedOut ? (
          <CardHeader>
            <CardTitle className="text-2xl tracking-tight">Almost there</CardTitle>
            <CardDescription>
              Your payment went through, but the confirmation is taking longer than usual. Your activation code will
              arrive by email shortly — no further action needed here.
            </CardDescription>
          </CardHeader>
        ) : (
          <CardHeader>
            <CardTitle className="text-2xl tracking-tight">Finishing up…</CardTitle>
            <CardDescription>Payment received — preparing your activation code.</CardDescription>
            <div className="space-y-2 pt-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </CardHeader>
        )}
      </Card>
    </main>
  )
}

function ReadyCard({ purchase }: { purchase: Purchase }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(purchase.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <>
      <CardHeader>
        <CardTitle className="text-2xl tracking-tight">
          Thanks for purchasing {purchase.productName} ({purchase.tier})!
        </CardTitle>
        <CardDescription>Your activation code:</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-md border bg-muted px-4 py-3 font-mono text-lg tracking-wider">
            {purchase.key}
          </code>
          <Button variant="outline" size="icon" onClick={() => void copy()} aria-label="Copy activation code">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Open the extension's settings and enter this code to activate — it covers up to {purchase.maxActivations}{' '}
          devices. A copy was also sent to <span className="font-medium">{purchase.buyerEmail}</span>; that email is
          your proof of purchase.
        </p>
      </CardContent>
    </>
  )
}
