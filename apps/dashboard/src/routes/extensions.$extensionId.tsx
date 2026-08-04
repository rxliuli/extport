import { api, ApiError, type DeploymentVersion, type PublishEvent, type PublishTarget, type Store } from '@/api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { credentialsQuery, extensionQuery, targetsQuery, timelineQuery } from '@/queries'
import { relativeTime } from '@/status'
import { ageDays } from '@/status'
import { VersionSummary } from '@/VersionSummary'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  SkipForward,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/extensions/$extensionId')({ component: ExtensionDetailLayout })

const STORES: Store[] = ['chrome', 'firefox', 'edge', 'safari']

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

export function TargetsSection({ extensionId }: { extensionId: string }) {
  const queryClient = useQueryClient()
  const { data: targets = [] } = useQuery(targetsQuery(extensionId))
  const { data: credentials = [] } = useQuery(credentialsQuery)
  const [store, setStore] = useState<Store>('chrome')
  const [credentialId, setCredentialId] = useState('')
  const [storeItemId, setStoreItemId] = useState('')
  const [crxId, setCrxId] = useState('')
  const [open, setOpen] = useState(false)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['extensions'] })

  const availableStores = STORES.filter((s) => !targets.some((t) => t.store === s))
  // `store` can point at a store that's no longer available (chrome already
  // configured by the time this mounts, or just added via this same form) —
  // don't let the credential list desync from what's visually selected.
  const selectedStore = availableStores.includes(store) ? store : (availableStores[0] ?? store)
  const matchingCredentials = credentials.filter((c) => c.store === selectedStore)
  // Default to the first (often only) match instead of making the tenant
  // re-pick something that isn't actually a choice.
  const selectedCredentialId = matchingCredentials.some((c) => c.id === credentialId)
    ? credentialId
    : (matchingCredentials[0]?.id ?? '')

  const add = useMutation({
    mutationFn: () =>
      api(`/api/v1/extensions/${extensionId}/targets`, {
        method: 'POST',
        body: JSON.stringify({
          store: selectedStore,
          credentialId: selectedCredentialId,
          storeItemId,
          ...(selectedStore === 'edge' && crxId ? { crxId } : {}),
        }),
      }),
    onSuccess: () => {
      setStoreItemId('')
      setCrxId('')
      setCredentialId('')
      setOpen(false)
      void invalidate()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const toggle = useMutation({
    mutationFn: (target: PublishTarget) =>
      api(`/api/v1/extensions/${extensionId}/targets/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !target.enabled }),
      }),
    onSuccess: () => void invalidate(),
    onError: (err) => toast.error(errorMessage(err)),
  })

  const remove = useMutation({
    mutationFn: (target: PublishTarget) => api(`/api/v1/extensions/${extensionId}/targets/${target.id}`, { method: 'DELETE' }),
    onSuccess: () => void invalidate(),
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Store targets</CardTitle>
        {availableStores.length > 0 && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <Plus /> Add a store
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add a store</DialogTitle>
              </DialogHeader>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (selectedCredentialId && storeItemId.trim()) add.mutate()
                }}
              >
                <Select
                  value={selectedStore}
                  onValueChange={(value: string) => {
                    setStore(value as Store)
                    setCredentialId('')
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableStores.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={selectedCredentialId} onValueChange={setCredentialId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select credential…" />
                  </SelectTrigger>
                  <SelectContent>
                    {matchingCredentials.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label} (…{c.hint})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={storeItemId}
                  onChange={(e) => setStoreItemId(e.target.value)}
                  placeholder={selectedStore === 'edge' ? 'Product ID (Partner Center → Extension identity)' : 'Store item id'}
                  required
                />
                {selectedStore === 'edge' && (
                  <Input
                    value={crxId}
                    onChange={(e) => setCrxId(e.target.value)}
                    placeholder="CRX ID (optional — public status lookups)"
                  />
                )}
                {selectedStore === 'edge' && (
                  <p className="text-xs text-muted-foreground">
                    Partner Center's submission API and its public status page use two different ids for the same
                    listing — Product ID is required for publishing; CRX ID is optional and only improves live-version
                    detection between reconciles.
                  </p>
                )}
                {matchingCredentials.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No {selectedStore} credential yet — add one in{' '}
                    <Link to="/settings" className="underline underline-offset-4">
                      Settings → Store credentials
                    </Link>{' '}
                    first.
                  </p>
                )}
                <Button type="submit" disabled={matchingCredentials.length === 0 || add.isPending} className="justify-self-start">
                  {add.isPending && <Loader2 className="animate-spin" />}
                  Add
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {targets.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Store</TableHead>
                <TableHead>Item ID</TableHead>
                <TableHead>Credential</TableHead>
                <TableHead>Version</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {targets.map((t) => (
                <TableRow key={t.id} className={t.enabled ? undefined : 'opacity-60'}>
                  <TableCell className="font-medium">{t.store}</TableCell>
                  <TableCell className="max-w-48">
                    <div className="truncate" title={t.storeItemId}>
                      <code className="text-xs">{t.storeItemId}</code>
                    </div>
                    {t.crxId && (
                      <div className="truncate text-xs text-muted-foreground" title={t.crxId}>
                        crx: <code>{t.crxId}</code>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {t.credentialLabel}{' '}
                    {t.credentialStatus !== 'active' && (
                      <Badge variant="destructive" className="ml-1">
                        {t.credentialStatus}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <VersionSummary lifecycles={t.lifecycles} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {!t.enabled && (
                      <Badge variant="outline" className="mr-2">
                        disabled
                      </Badge>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.store} target`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem disabled={toggle.isPending} onSelect={() => toggle.mutate(t)}>
                          {t.enabled ? 'Disable' : 'Enable'}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" disabled={remove.isPending} onSelect={() => remove.mutate(t)}>
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {targets.length === 0 && <p className="text-sm text-muted-foreground">No stores configured yet.</p>}
      </CardContent>
    </Card>
  )
}

// Cell vocabulary for the version × store matrix. Shape carries the meaning,
// color only reinforces it (color alone is invisible to color-blind readers).
const CELL: Record<DeploymentVersion['status'], { Icon: LucideIcon; className: string; label: string }> = {
  online: { Icon: CircleCheck, className: 'text-green-700 dark:text-green-500', label: 'live' },
  in_review: { Icon: Clock, className: 'text-amber-600 dark:text-amber-400', label: 'in review' },
  queued: { Icon: CircleDashed, className: 'text-amber-600 dark:text-amber-400', label: 'queued' },
  skipped: { Icon: SkipForward, className: 'text-muted-foreground', label: 'skipped' },
  rejected: { Icon: CircleX, className: 'text-red-600 dark:text-red-400', label: 'rejected' },
}

/** Numeric-aware compare, same semantics as @extport/shared's compareVersions (1.10 > 1.9). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function cellTitle(row: DeploymentVersion, isCurrentLive: boolean): string {
  const days = ageDays(row.submittedAt)
  const parts: string[] = []
  if (row.status === 'online') parts.push(isCurrentLive ? 'live now' : 'was live')
  else if (row.status === 'in_review' && days !== null) parts.push(`in review for ${days}d`)
  else parts.push(CELL[row.status].label)
  if (row.statusDetail) parts.push(row.statusDetail)
  parts.push(`updated ${relativeTime(row.updatedAt)}`)
  return parts.join(' · ')
}

const OPS_EVENT: Record<PublishEvent['type'], { className: string; label: string }> = {
  error: { className: 'text-red-600 dark:text-red-400', label: 'error' },
  recovered: { className: 'text-green-700 dark:text-green-500', label: 'recovered' },
  stale_review: { className: 'text-amber-600 dark:text-amber-400', label: 'stale review' },
}

function opsEventDetail(event: PublishEvent): string | null {
  const { payload } = event
  if (event.type === 'error') return typeof payload.message === 'string' ? payload.message : null
  if (event.type === 'stale_review') return `in review for ${payload.ageDays}+ days`
  return null
}

// deployment_versions pivoted into rows = versions, columns = stores — the
// release-progress view. Target-level health (error/recovered/stale_review)
// has no version to belong to, so it lives in the ops list below instead.
export function VersionMatrixSection({ extensionId }: { extensionId: string }) {
  const { data } = useQuery(timelineQuery(extensionId))
  const { data: targets = [] } = useQuery(targetsQuery(extensionId))
  const versions = data?.versions ?? []
  const events = data?.events ?? []

  // A store can have deployment_versions rows before it has a publish
  // target — pushes are accepted early so tenants can wire up CI before
  // every store's credentials are ready (queueLatestArtifact backfills the
  // target once one's added). This matrix is meant to show the health of
  // your CONFIGURED pipeline, not that leftover pre-target queue, so it
  // only gets a column once a target actually exists for it.
  const configuredStores = new Set(targets.map((t) => t.store))

  // One column per lifecycle: plain stores get one, Safari gets one per
  // platform present in the rows (labelled "safari (macos)" etc.).
  const columns = STORES.filter((store) => configuredStores.has(store)).flatMap((store) => {
    const storeRows = versions.filter((v) => v.store === store)
    if (storeRows.length === 0) return []
    // Same platform order as the server's deriveTargetLifecycles: macos, ios.
    const platformOrder = [null, 'macos', 'ios']
    const platforms = [...new Set(storeRows.map((v) => v.platform ?? null))].sort(
      (a, b) => platformOrder.indexOf(a) - platformOrder.indexOf(b),
    )
    return platforms.map((platform) => ({
      key: `${store}:${platform ?? ''}`,
      store,
      platform,
      label: platform ? `${store} (${platform})` : store,
    }))
  })
  const versionNumbers = [...new Set(versions.map((v) => v.version))].sort((a, b) => compareVersions(b, a))

  // The endpoint returns newest-first; keep the first (freshest) row per cell.
  const byCell = new Map<string, DeploymentVersion>()
  for (const v of versions) {
    const key = `${v.store}:${v.platform ?? ''}:${v.version}`
    if (!byCell.has(key)) byCell.set(key, v)
  }

  // Per column, only the MAX online version is live right now; older online
  // rows are history ("was live") and render faded so it can't read as
  // several versions being live at once.
  const currentLive = new Map<string, string>()
  for (const column of columns) {
    const online = versions
      .filter((v) => v.store === column.store && (v.platform ?? null) === column.platform && v.status === 'online')
      .map((v) => v.version)
    if (online.length > 0) currentLive.set(column.key, online.sort(compareVersions).at(-1)!)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
        </CardHeader>
        <CardContent>
          {versionNumbers.length === 0 && <p className="text-sm text-muted-foreground">No versions tracked yet.</p>}
          {versionNumbers.length > 0 && (
            <>
              <Table className="w-auto">
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    {columns.map((column) => (
                      <TableHead key={column.key} className="px-4 text-center">
                        {column.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versionNumbers.map((version) => (
                    <TableRow key={version}>
                      <TableCell>
                        <code className="text-xs">{version}</code>
                      </TableCell>
                      {columns.map((column) => {
                        const row = byCell.get(`${column.store}:${column.platform ?? ''}:${version}`)
                        if (!row) return <TableCell key={column.key} />
                        const isCurrentLive = row.status === 'online' && currentLive.get(column.key) === version
                        const wasLive = row.status === 'online' && !isCurrentLive
                        const { Icon, className, label } = CELL[row.status]
                        return (
                          <TableCell key={column.key} className="text-center">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                {/* Icon only — age, statusDetail, and exactly what "in review"
                                    means for this row all live in the tooltip, not duplicated here. */}
                                <span className={`inline-flex items-center ${className} ${wasLive ? 'opacity-35' : ''}`}>
                                  <Icon size={16} strokeWidth={2.25} aria-label={label} />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{cellTitle(row, isCurrentLive)}</TooltipContent>
                            </Tooltip>
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                {(Object.keys(CELL) as DeploymentVersion['status'][]).map((status) => {
                  const { Icon, className, label } = CELL[status]
                  return (
                    <span key={status} className="inline-flex items-center gap-1">
                      <Icon size={13} strokeWidth={2.25} className={className} /> {label}
                    </span>
                  )
                })}
                <span>— hover a cell for details</span>
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {events.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Operational events</CardTitle>
            <CardDescription>
              Target-level health transitions — one entry when a store starts failing, one when it recovers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {events.slice(0, 10).map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{relativeTime(e.createdAt)}</TableCell>
                    <TableCell>{e.store}</TableCell>
                    <TableCell className={`font-semibold ${OPS_EVENT[e.type].className}`}>{OPS_EVENT[e.type].label}</TableCell>
                    <TableCell className="max-w-xl truncate text-xs text-muted-foreground" title={opsEventDetail(e) ?? undefined}>
                      {opsEventDetail(e)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function ExtensionDetailLayout() {
  const { extensionId } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: extension, isPending } = useQuery(extensionQuery(extensionId))

  const reconcile = useMutation({
    mutationFn: () =>
      api<{ summary: { processed: number; submitted: number; blocked: number; errors: number } }>(
        `/api/v1/extensions/${extensionId}/reconcile`,
        { method: 'POST' },
      ),
    onSuccess: ({ summary }) => {
      const text = `processed ${summary.processed} · submitted ${summary.submitted} · blocked ${summary.blocked} · errors ${summary.errors}`
      if (summary.errors > 0) toast.warning(text)
      else toast.success(text)
      void queryClient.invalidateQueries({ queryKey: ['extensions'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const deleteExtension = useMutation({
    mutationFn: () => api(`/api/v1/extensions/${extensionId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['extensions'] })
      void navigate({ to: '/' })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  if (isPending || !extension) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft size={14} /> Back to extensions
        </Link>
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">{extension.name}</h2>
            <code className="text-xs text-muted-foreground">{extension.id}</code>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
              {reconcile.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Reconcile
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Delete extension"
                  className="text-red-600 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400"
                >
                  <Trash2 />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete “{extension.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes all its artifacts, store targets, and history. Nothing is touched on the stores
                    themselves. This can't be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-red-600 text-white hover:bg-red-700"
                    onClick={() => deleteExtension.mutate()}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>

      {/* Real routes rather than tab state so both halves have copyable,
          deep-linkable URLs. */}
      <nav className="flex items-center gap-1 rounded-lg bg-muted p-1 text-sm font-medium w-fit">
        {(['publishing', 'licensing', 'analytics'] as const).map((section) => (
          <Link
            key={section}
            to={`/extensions/$extensionId/${section}`}
            params={{ extensionId }}
            className="rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
            activeProps={{ className: 'bg-background text-foreground shadow-sm' }}
          >
            {section === 'publishing' ? 'Publishing' : section === 'licensing' ? 'Licensing' : 'Analytics'}
          </Link>
        ))}
      </nav>

      <Outlet />
    </div>
  )
}
