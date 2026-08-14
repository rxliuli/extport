import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/extra/card'
import { meQuery } from '@/queries'
import { createFileRoute, redirect } from '@tanstack/react-router'

// lucide-react dropped brand icons, so the GitHub mark is inlined.
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className="size-4">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

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
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl tracking-tight">extport</CardTitle>
          <CardDescription>
            Publish to Chrome, Firefox, Edge, and Safari from one dashboard — licensing and analytics included.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button asChild className="w-full">
            <a href={href}>
              <GithubMark /> Sign in with GitHub
            </a>
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Free during the beta — no waitlist, new accounts work immediately.
          </p>
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">
        New here?{' '}
        <a href="https://extport.dev" className="underline underline-offset-4 hover:text-foreground">
          extport.dev
        </a>{' '}
        ·{' '}
        <a href="https://docs.extport.dev" className="underline underline-offset-4 hover:text-foreground">
          Docs
        </a>{' '}
        ·{' '}
        <a href="https://discord.gg/Va9kcSqu3f" className="underline underline-offset-4 hover:text-foreground">
          Discord
        </a>
      </p>
    </main>
  )
}
