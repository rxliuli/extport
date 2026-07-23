import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { meQuery } from '@/queries'
import type { QueryClient } from '@tanstack/react-query'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'

interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // Runs on every navigation, before the matched route renders — /login is
  // the one exception, or signing in would just bounce you back to itself.
  beforeLoad: async ({ context, location }) => {
    if (location.pathname === '/login') return
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
    if (me === null && window.location.pathname !== '/login') {
      void navigate({ to: '/login', search: { returnTo: window.location.pathname + window.location.search } })
    }
  }, [me, navigate])

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    queryClient.setQueryData(meQuery.queryKey, null)
    await navigate({ to: '/login' })
  }

  return (
    <TooltipProvider delayDuration={200}>
      {!me ? (
        <Outlet />
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
