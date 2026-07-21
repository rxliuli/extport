import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { meQuery } from '@/queries'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createRootRoute, Link, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({ component: RootLayout })

function RootLayout() {
  const { data: me, isPending } = useQuery(meQuery)
  const queryClient = useQueryClient()

  if (isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-6 py-10">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!me) {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-2xl tracking-tight">extport</CardTitle>
            <CardDescription>Browser extension publishing &amp; licensing platform.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <a href="/api/auth/github">Sign in with GitHub</a>
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    queryClient.setQueryData(meQuery.queryKey, null)
  }

  return (
    <TooltipProvider delayDuration={200}>
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
      <Toaster richColors />
    </TooltipProvider>
  )
}
