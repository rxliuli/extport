import { api, ApiError } from '@/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/extra/card'
import { meQuery } from '@/queries'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

interface CliAuthSearch {
  port?: number
}

export const Route = createFileRoute('/cli-auth')({
  component: CliAuthPage,
  validateSearch: (search: Record<string, unknown>): CliAuthSearch => {
    const port = Number(search.port)
    return { port: Number.isInteger(port) && port > 0 ? port : undefined }
  },
})

type Status = 'idle' | 'authorizing' | 'done' | 'error'

/**
 * `extport login`'s loopback flow, browser half: the CLI opened this with
 * ?port=<local server> and is waiting. Authorizing mints a real API key
 * server-side (POST /cli-auth/start) and hands back a short-lived one-time
 * code, not the key itself — this page's own top-level navigation to
 * http://127.0.0.1:<port>/callback is what delivers it, so the key itself
 * never sits in this page's URL bar or history, only the single-use code.
 */
function CliAuthPage() {
  const { data: me } = useQuery(meQuery)
  const { port } = Route.useSearch()
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)

  const authorize = async () => {
    setStatus('authorizing')
    try {
      const { code } = await api<{ code: string }>('/api/v1/cli-auth/start', { method: 'POST' })
      setStatus('done')
      window.location.href = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(code)}`
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
      setStatus('error')
    }
  }

  if (!port) {
    return (
      <Card className="mx-auto mt-20 max-w-md">
        <CardHeader>
          <CardTitle>Invalid link</CardTitle>
          <CardDescription>This page is opened by "extport login" — it's missing the local callback port.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className="mx-auto mt-20 max-w-md">
      <CardHeader>
        <CardTitle>Authorize the extport CLI</CardTitle>
        <CardDescription>
          A command-line tool on this machine wants to publish on behalf of <span className="font-medium text-foreground">{me?.tenant.name}</span>. This
          creates a new API key (visible afterward in Settings → API keys).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === 'error' && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {status === 'done' ? (
          <p className="text-sm text-muted-foreground">Authorized — you can close this tab and return to the terminal.</p>
        ) : (
          <Button onClick={() => void authorize()} disabled={status === 'authorizing'} className="w-full">
            Authorize CLI access
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
