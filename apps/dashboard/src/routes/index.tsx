import { api, ApiError, type Store } from '@/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { matrixQuery } from '@/queries'
import { VersionSummary } from '@/VersionSummary'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/')({ component: ExtensionsPage })

const STORES: Store[] = ['chrome', 'firefox', 'edge', 'safari']
const STORE_LABEL: Record<Store, string> = { chrome: 'Chrome', firefox: 'Firefox', edge: 'Edge', safari: 'Safari' }

function ExtensionsPage() {
  const { data: extensions, isPending } = useQuery(matrixQuery)
  const queryClient = useQueryClient()
  const [name, setName] = useState('')

  const create = useMutation({
    mutationFn: (name: string) => api('/api/v1/extensions', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: () => {
      setName('')
      void queryClient.invalidateQueries({ queryKey: ['extensions'] })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : String(err)),
  })

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Extensions</CardTitle>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) create.mutate(name.trim())
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Extension name"
            className="h-8 w-48"
            required
          />
          <Button type="submit" size="sm" disabled={create.isPending}>
            <Plus /> Add
          </Button>
        </form>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Extension</TableHead>
                  {STORES.map((s) => (
                    <TableHead key={s}>{STORE_LABEL[s]}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(extensions ?? []).map((ext) => (
                  <TableRow key={ext.id}>
                    <TableCell>
                      <Link
                        to="/extensions/$extensionId"
                        params={{ extensionId: ext.id }}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {ext.name}
                      </Link>
                    </TableCell>
                    {STORES.map((s) => {
                      const target = ext.targets.find((t) => t.store === s)
                      return (
                        <TableCell key={s}>
                          {target ? <VersionSummary lifecycles={target.lifecycles} /> : <span className="text-muted-foreground/50">—</span>}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {(extensions ?? []).length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">No extensions yet — add your first one above.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
