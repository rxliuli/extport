import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { meQuery } from '@/queries'
import { createFileRoute, redirect } from '@tanstack/react-router'

// Same-origin only — never let this become an open redirect, whether the
// value round-tripped through our own /login link or (defense in depth)
// came back out of the server's returnTo cookie some other way.
function isSafeReturnTo(path: string): path is string {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')
}

interface LoginSearch {
  returnTo?: string
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    returnTo: typeof search.returnTo === 'string' && isSafeReturnTo(search.returnTo) ? search.returnTo : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    // Already signed in and landed here anyway (stale bookmark, back
    // button) — go wherever this was headed instead of showing the card again.
    const me = await context.queryClient.ensureQueryData(meQuery)
    if (me) throw redirect({ to: search.returnTo ?? '/' })
  },
  component: LoginPage,
})

function LoginPage() {
  const { returnTo } = Route.useSearch()
  const href = returnTo ? `/api/auth/github?returnTo=${encodeURIComponent(returnTo)}` : '/api/auth/github'

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl tracking-tight">extport</CardTitle>
          <CardDescription>Browser extension publishing &amp; licensing platform.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <a href={href}>Sign in with GitHub</a>
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
