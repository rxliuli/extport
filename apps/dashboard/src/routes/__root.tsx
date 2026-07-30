import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { meQuery } from '@/queries'
import type { Me } from '@/api'
import type { QueryClient } from '@tanstack/react-query'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'

// Mirrors apps/api/src/routes/auth.ts's DISCORD_INVITE_URL — the closed
// beta's touchpoint while a tenant sits in 'pending'.
const DISCORD_INVITE_URL = 'https://discord.gg/Va9kcSqu3f'

interface RouterContext {
  queryClient: QueryClient
}

// Buyer-facing pages (canonically served on portal.extport.dev, same
// Worker) and /login live outside the tenant session: no auth redirect,
// no tenant chrome.
function isPublicPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/portal') || pathname.startsWith('/purchase')
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // Runs on every navigation, before the matched route rendered — public
  // paths are exempt, or signing in would just bounce you back to itself
  // (and buyers have no tenant session at all).
  beforeLoad: async ({ context, location }) => {
    if (isPublicPath(location.pathname)) return
    const me = await context.queryClient.ensureQueryData(meQuery)
    if (!me) {
      throw redirect({ to: '/login', search: { returnTo: location.href } })
    }
  },
  pendingComponent: () => (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-10">
      <Skeleton className="h-8 w-44" />
      <Skeleton className="h-40 w-full" />
    </div>
  ),
  component: RootLayout,
})

function RootLayout() {
  const { data: me } = useQuery(meQuery)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  // beforeLoad already redirects whenever `me` is null at the START of a
  // navigation — this covers the other case, the session dying while
  // already sitting on a page (e.g. signed out in another tab), since a
  // live query going to null doesn't re-run beforeLoad on its own.
  useEffect(() => {
    if (me === null && !isPublicPath(window.location.pathname)) {
      void navigate({ to: '/login', search: { returnTo: window.location.pathname + window.location.search } })
    }
  }, [me, navigate])

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    queryClient.setQueryData(meQuery.queryKey, null)
    await navigate({ to: '/login' })
  }

  // Buyer pages render chrome-less even for a signed-in tenant — the
  // audience is the buyer, not the tenant dashboard.
  if (isPublicPath(window.location.pathname) && window.location.pathname !== '/login') {
    return (
      <TooltipProvider delayDuration={200}>
        <Outlet />
        <Toaster richColors />
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider delayDuration={200}>
      {!me ? (
        <Outlet />
      ) : me.tenant.status === 'pending' ? (
        <PendingScreen me={me} onSignOut={() => void signOut()} />
      ) : (
        <div className="mx-auto max-w-5xl px-6 py-6">
          <header className="mb-8 flex items-center gap-6">
            <Link to="/" className="text-xl font-bold tracking-tight">
              extport
            </Link>
            <nav className="flex items-center gap-1">
              <Link
                to="/"
                className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                activeOptions={{ exact: true }}
                activeProps={{ className: 'bg-accent text-foreground' }}
              >
                Extensions
              </Link>
              <Link
                to="/licenses"
                className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                activeProps={{ className: 'bg-accent text-foreground' }}
              >
                Licenses
              </Link>
              <Link
                to="/settings"
                className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                activeProps={{ className: 'bg-accent text-foreground' }}
              >
                Settings
              </Link>
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
              <span>{me.user?.displayName ?? me.user?.email}</span>
              <Badge variant="secondary">{me.tenant.plan}</Badge>
              <Button variant="outline" size="sm" onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          </header>
          <Outlet />
        </div>
      )}
      <Toaster richColors />
    </TooltipProvider>
  )
}

function PendingScreen({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl tracking-tight">You're on the list</CardTitle>
          <CardDescription>
            Hi {me.user?.displayName ?? me.user?.email} — extport is in closed beta and new accounts are reviewed by
            hand. We'll email you once yours is activated.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild className="w-full">
            <a href={DISCORD_INVITE_URL} target="_blank" rel="noreferrer">
              Join the Discord
            </a>
          </Button>
          <Button variant="outline" className="w-full" onClick={onSignOut}>
            Sign out
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
