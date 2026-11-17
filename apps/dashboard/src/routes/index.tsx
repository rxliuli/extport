import { api, ApiError, type MatrixExtension, type MatrixTarget, type SafariPlatform, type Store } from '@/api'
import { classifyFleet, storeName, type ActionItem, type ExtensionHealth } from '@/attention'
import { PageHeader } from '@/components/Section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { matrixQuery, tenantSettingsQuery } from '@/queries'
import { VersionSummary } from '@/VersionSummary'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/')({ component: ExtensionsPage })

// One column per lifecycle, so every cell holds exactly one status and each
// column scans vertically. Safari splits by platform, macOS first so the
// desktop browsers stay contiguous and iOS closes the row — the same order as
// the server's deriveTargetLifecycles and the extension page.
const COLUMNS: { store: Store; platform: SafariPlatform | null }[] = [
  { store: 'chrome', platform: null },
  { store: 'firefox', platform: null },
  { store: 'edge', platform: null },
  { store: 'safari', platform: 'macos' },
  { store: 'safari', platform: 'ios' },
]
const STORES = [...new Set(COLUMNS.map((c) => c.store))]

const DASH = <span className="text-muted-foreground/50">—</span>

function targetCells(target: MatrixTarget | undefined, columns: typeof COLUMNS) {
  const dim = target && !target.enabled ? 'opacity-50' : undefined
  // A Safari target with no platform-tagged rows yet (nothing published, or
  // the first publish failed) has one platform-less lifecycle: span it across
  // both Safari columns instead of guessing a platform.
  if (target && columns.length > 1 && target.lifecycles.every((l) => l.platform === null)) {
    const lifecycle = target.lifecycles[0]
    return [
      <TableCell key="all" colSpan={columns.length} className={dim}>
        {lifecycle ? <VersionSummary lifecycle={lifecycle} /> : DASH}
      </TableCell>,
    ]
  }
  return columns.map((c) => {
    const lifecycle = target?.lifecycles.find((l) => l.platform === c.platform)
    return (
      <TableCell key={c.platform ?? 'default'} className={dim}>
        {lifecycle ? <VersionSummary lifecycle={lifecycle} /> : DASH}
      </TableCell>
    )
  })
}

// Fallback until the settings request lands — mirrors @extport/shared's
// DEFAULT_STALE_REVIEW_DAYS so the first paint already classifies sensibly.
const DEFAULT_STALE_REVIEW_DAYS: Record<Store, number> = { chrome: 3, firefox: 3, edge: 10, safari: 3 }

type Filter = 'all' | ExtensionHealth

const HEALTH_RANK: Record<ExtensionHealth, number> = { action: 0, in_flight: 1, ok: 2 }

const ACTION_DOT: Record<ActionItem['kind'], string> = {
  error: 'bg-red-600 dark:bg-red-400',
  rejected: 'bg-red-600 dark:bg-red-400',
  credential: 'bg-red-600 dark:bg-red-400',
  stale_review: 'bg-amber-500 dark:bg-amber-400',
  not_set_up: 'bg-muted-foreground/50',
}

const ACTION_LABEL_TONE: Record<ActionItem['kind'], string> = {
  error: 'text-red-700 dark:text-red-400',
  rejected: 'text-red-700 dark:text-red-400',
  credential: 'text-red-700 dark:text-red-400',
  stale_review: 'text-amber-700 dark:text-amber-400',
  not_set_up: 'text-muted-foreground',
}

function ExtensionsPage() {
  const { data: extensions, isPending } = useQuery(matrixQuery)
  const { data: settings } = useQuery(tenantSettingsQuery)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const create = useMutation({
    mutationFn: (name: string) => api('/api/v1/extensions', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: () => {
      setName('')
      void queryClient.invalidateQueries({ queryKey: ['extensions'] })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : String(err)),
  })

  const all = extensions ?? []
  const attention = useMemo(
    () => classifyFleet(all, settings?.staleReviewDays ?? DEFAULT_STALE_REVIEW_DAYS),
    [all, settings],
  )
  const healthOf = (ext: MatrixExtension): ExtensionHealth => attention.health.get(ext.id) ?? 'ok'
  const counts = {
    all: all.length,
    action: all.filter((e) => healthOf(e) === 'action').length,
    in_flight: all.filter((e) => healthOf(e) === 'in_flight').length,
    ok: all.filter((e) => healthOf(e) === 'ok').length,
  }
  // Stable sort: needs-action first, then in-flight, then the rest in API order.
  const rows = all
    .map((ext, index) => ({ ext, index, health: healthOf(ext) }))
    .filter((row) => filter === 'all' || row.health === filter)
    .sort((a, b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health] || a.index - b.index)

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'action', label: 'Needs action' },
    { id: 'in_flight', label: 'In review' },
    { id: 'ok', label: 'Up to date' },
  ]

  return (
    <div className="space-y-8">
      <PageHeader
        title="Extensions"
        description={
          !isPending && (
            <>
              {counts.all} extensions
              {counts.action > 0 && ` · ${counts.action} need${counts.action === 1 ? 's' : ''} your action`}
            </>
          )
        }
        action={
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
              placeholder="New extension name"
              aria-label="New extension name"
              className="h-9 w-52"
              required
            />
            <Button type="submit" disabled={create.isPending}>
              <Plus /> Add extension
            </Button>
          </form>
        }
      />

      {isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <>
          {(attention.actions.length > 0 || attention.inFlight.length > 0) && (
            <section className="overflow-hidden rounded-xl border bg-card" data-slot="card">
              {attention.actions.length > 0 && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3.5">
                    <h2 className="text-[15px] font-semibold">
                      Needs your action{' '}
                      <span className="font-medium text-muted-foreground">{attention.actions.length}</span>
                    </h2>
                    <span className="text-xs text-muted-foreground">Things extport can’t resolve on its own</span>
                  </div>
                  <ul>
                    {attention.actions.map((item) => (
                      <li
                        key={`${item.extensionId}:${item.kind}:${item.store ?? ''}:${item.platform ?? ''}`}
                        className="flex flex-wrap items-start gap-x-3.5 gap-y-2 border-b px-5 py-4 last:border-b-0"
                      >
                        <span
                          className={`mt-1.5 size-2 shrink-0 rounded-full ${ACTION_DOT[item.kind]}`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-[1_1_420px] space-y-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <Link
                              to="/extensions/$extensionId"
                              params={{ extensionId: item.extensionId }}
                              className="font-semibold underline-offset-4 hover:underline"
                            >
                              {item.extensionName}
                            </Link>
                            <span className="text-muted-foreground">
                              {item.store ? storeName(item.store, item.platform) : 'No stores'}
                            </span>
                            <span className={`text-xs font-semibold ${ACTION_LABEL_TONE[item.kind]}`}>
                              {item.label}
                            </span>
                          </div>
                          <p className="text-sm leading-relaxed text-muted-foreground">{item.message}</p>
                        </div>
                        <Button variant="outline" size="sm" asChild className="shrink-0">
                          {item.kind === 'credential' ? (
                            <Link to="/settings">Open Settings</Link>
                          ) : (
                            <Link to="/extensions/$extensionId" params={{ extensionId: item.extensionId }}>
                              {item.kind === 'not_set_up' ? 'Add a store' : 'View details'}
                            </Link>
                          )}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {attention.inFlight.length > 0 && (
                <div className={`space-y-2 bg-muted/40 px-5 py-3.5 ${attention.actions.length > 0 ? 'border-t' : ''}`}>
                  <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    In review · nothing to do yet
                  </p>
                  <ul className="space-y-1.5 text-sm">
                    {attention.inFlight.map((item) => (
                      <li
                        key={`${item.extensionId}:${item.store}:${item.platform ?? ''}`}
                        className="flex flex-wrap items-baseline gap-x-2.5"
                      >
                        <span
                          className="size-1.5 shrink-0 self-center rounded-full bg-amber-500 dark:bg-amber-400"
                          aria-hidden="true"
                        />
                        <Link
                          to="/extensions/$extensionId"
                          params={{ extensionId: item.extensionId }}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {item.extensionName}
                        </Link>
                        <span className="text-muted-foreground">
                          {storeName(item.store, item.platform)} · {item.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter extensions">
                {filters.map((f) => (
                  <Button
                    key={f.id}
                    size="sm"
                    variant={filter === f.id ? 'default' : 'outline'}
                    className="rounded-full"
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label} <span className="opacity-60">{counts[f.id]}</span>
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-3.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-green-600 dark:bg-green-400" /> Live
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-amber-500 dark:bg-amber-400" /> Live → in review
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-red-600 dark:bg-red-400" /> Rejected / failed
                </span>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border bg-card" data-slot="card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Extension</TableHead>
                    {COLUMNS.map((c) => (
                      <TableHead key={`${c.store}:${c.platform ?? ''}`}>{storeName(c.store, c.platform)}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ ext, health }) => (
                    <TableRow
                      key={ext.id}
                      onClick={() => navigate({ to: '/extensions/$extensionId', params: { extensionId: ext.id } })}
                      className={`cursor-pointer ${health === 'action' ? 'bg-amber-50/60 dark:bg-amber-400/5' : ''}`}
                    >
                      <TableCell className="pl-5">
                        <Link
                          to="/extensions/$extensionId"
                          params={{ extensionId: ext.id }}
                          className="font-medium underline-offset-4 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {ext.name}
                        </Link>
                      </TableCell>
                      {STORES.flatMap((s) =>
                        targetCells(
                          ext.targets.find((t) => t.store === s),
                          COLUMNS.filter((c) => c.store === s),
                        ),
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {all.length > 0 && rows.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">Nothing in this view.</p>
              )}
              {all.length === 0 && (
                <div className="space-y-1 py-6 text-center text-sm text-muted-foreground">
                  <p>No extensions yet — add your first one above.</p>
                  <p>
                    Already published to the stores? Same thing — after creating it, paste the store listing URL when
                    connecting a store target. See the{' '}
                    <a
                      href="https://docs.extport.dev/getting-started/"
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4 hover:text-foreground"
                    >
                      getting-started guide
                    </a>
                    .
                  </p>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
