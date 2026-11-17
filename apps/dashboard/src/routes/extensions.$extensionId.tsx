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
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { STORE_LABEL as STORE_NAME, storeName } from '@/attention'
import { Section, sectionEmptyClass, sectionFooterClass, sectionRowClass } from '@/components/Section'
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
import { parseListingUrl } from '@/lib/store-listing-url'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { credentialsQuery, extensionQuery, targetsQuery, timelineQuery } from '@/queries'
import { ageDays, formatDate, relativeTime, summarizeStoreError } from '@/status'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router'
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Copy,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  SkipForward,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'
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
  // The store item id is what tenants actually come here to type (store and
  // credential already have sensible defaults), so land focus there when the
  // dialog opens instead of on the store select. Without this, Radix's
  // FocusScope focuses the first tabbable element — the Select trigger.
  const storeItemIdRef = useRef<HTMLInputElement>(null)

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

  // The id fields accept a pasted store listing URL — that URL is where most
  // tenants go hunting for the id anyway, so extract it for them. A parsed URL
  // also names its store, which overrides whatever the select happened to be on.
  const handleItemIdInput = (value: string) => {
    const parsed = parseListingUrl(value)
    if (!parsed) {
      setStoreItemId(value)
      return
    }
    if (!availableStores.includes(parsed.store)) {
      setStoreItemId(value)
      toast.error(`That's a ${parsed.store} listing URL — ${parsed.store} is already connected on this extension.`)
      return
    }
    if (parsed.store !== selectedStore) {
      setStore(parsed.store)
      setCredentialId('')
    }
    if (parsed.field === 'crxId') {
      setCrxId(parsed.id)
      setStoreItemId('')
      toast.info(
        'Edge listing URLs carry the CRX ID — filled it in below. The Product ID comes from Partner Center → Extension identity.',
      )
    } else {
      setStoreItemId(parsed.id)
    }
  }

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
    mutationFn: (target: PublishTarget) =>
      api(`/api/v1/extensions/${extensionId}/targets/${target.id}`, { method: 'DELETE' }),
    onSuccess: () => void invalidate(),
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Section
      title="Store connections"
      description="Listing IDs and the credential each store publishes with."
      action={
        availableStores.length > 0 && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" aria-label="Add a store">
                <Plus /> <span className="hidden sm:inline">Add a store</span>
              </Button>
            </DialogTrigger>
            <DialogContent
              onOpenAutoFocus={(e: Event) => {
                e.preventDefault()
                storeItemIdRef.current?.focus()
              }}
            >
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
                        {STORE_NAME[s]}
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
                  ref={storeItemIdRef}
                  value={storeItemId}
                  onChange={(e) => handleItemIdInput(e.target.value)}
                  placeholder={
                    selectedStore === 'edge'
                      ? 'Product ID (Partner Center → Extension identity)'
                      : 'Store item id or listing URL'
                  }
                  required
                />
                {selectedStore === 'edge' && (
                  <Input
                    value={crxId}
                    onChange={(e) => {
                      const parsed = parseListingUrl(e.target.value)
                      setCrxId(parsed?.store === 'edge' ? parsed.id : e.target.value)
                    }}
                    placeholder="CRX ID or listing URL (optional — public status lookups)"
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
                <Button
                  type="submit"
                  disabled={matchingCredentials.length === 0 || add.isPending}
                  className="justify-self-start"
                >
                  {add.isPending && <Loader2 className="animate-spin" />}
                  Add
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        )
      }
    >
      {targets.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Store</TableHead>
              <TableHead>Item ID</TableHead>
              <TableHead>Credential</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {targets.map((t) => (
              <TableRow key={t.id} className={t.enabled ? undefined : 'opacity-60'}>
                <TableCell className="font-medium">{STORE_NAME[t.store]}</TableCell>
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
                <TableCell className="whitespace-nowrap text-right">
                  {!t.enabled &&
                    (t.disabledSource === 'auto' ? (
                      <Badge variant="destructive" className="mr-2" title={t.disabledReason ?? undefined}>
                        paused
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="mr-2">
                        disabled
                      </Badge>
                    ))}
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
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={remove.isPending}
                        onSelect={() => remove.mutate(t)}
                      >
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
      {targets.length === 0 && <p className={sectionEmptyClass}>No stores configured yet.</p>}
    </Section>
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
  error: { className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300', label: 'Failed' },
  recovered: { className: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300', label: 'Recovered' },
  stale_review: {
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    label: 'Slow review',
  },
  paused: { className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300', label: 'Paused' },
  interrupted: { className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300', label: 'Interrupted' },
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return hours === 1 ? '1 hour' : `${hours} hours`
  return `${Math.round(hours / 24)} days`
}

function describeEvent(event: PublishEvent, all: PublishEvent[]): { text: string; raw: string | null } {
  const { payload } = event
  if (event.type === 'error') {
    const message = typeof payload.message === 'string' ? payload.message : null
    return { text: message ? summarizeStoreError(message) : 'Publishing failed.', raw: message }
  }
  if (event.type === 'recovered') {
    // Events are newest-first: the failure this recovers from is the next
    // error for the same store further down the list.
    const index = all.indexOf(event)
    const failure = all.slice(index + 1).find((e) => e.store === event.store && e.type === 'error')
    const took = failure ? new Date(event.createdAt).getTime() - new Date(failure.createdAt).getTime() : null
    return {
      text: took !== null ? `Publishing recovered after ${formatDuration(took)}.` : 'Publishing recovered.',
      raw: null,
    }
  }
  if (event.type === 'stale_review') {
    return { text: `A review had been pending for ${String(payload.ageDays)}+ days, past your threshold.`, raw: null }
  }
  if (event.type === 'paused') {
    const reason = typeof payload.reason === 'string' ? payload.reason : null
    return { text: reason ? `Publishing was paused: ${reason}` : 'Publishing was paused.', raw: null }
  }
  const abandonedAt = typeof payload.abandonedAt === 'string' ? payload.abandonedAt : null
  return {
    text: 'A sync stopped partway through. The next run picked it up again automatically; nothing was lost.',
    raw: abandonedAt ? `lock abandoned at ${abandonedAt.replace('T', ' ').slice(0, 19)} UTC` : null,
  }
}

const RECENT_VERSION_COUNT = 5

// deployment_versions pivoted into rows = versions, columns = stores — the
// release-progress view. Target-level health (error/recovered/stale_review)
// has no version to belong to, so it lives in the ops list below instead.
export function VersionMatrixSection({ extensionId }: { extensionId: string }) {
  const { data } = useQuery(timelineQuery(extensionId))
  const { data: targets = [] } = useQuery(targetsQuery(extensionId))
  const versions = data?.versions ?? []
  const events = data?.events ?? []
  const [showAllVersions, setShowAllVersions] = useState(false)

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
      label: storeName(store, platform),
    }))
  })
  const versionNumbers = [...new Set(versions.map((v) => v.version))].sort((a, b) => compareVersions(b, a))
  const visibleVersions = showAllVersions ? versionNumbers : versionNumbers.slice(0, RECENT_VERSION_COUNT)

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
    <div className="space-y-8">
      <Section
        title={showAllVersions ? 'All versions' : 'Recent versions'}
        action={
          versionNumbers.length > RECENT_VERSION_COUNT && (
            <Button variant="outline" size="sm" onClick={() => setShowAllVersions((v) => !v)}>
              {showAllVersions ? 'Show recent only' : `Show all ${versionNumbers.length}`}
            </Button>
          )
        }
      >
        {versionNumbers.length === 0 && <p className={sectionEmptyClass}>No versions tracked yet.</p>}
        {versionNumbers.length > 0 && (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  {columns.map((column) => (
                    <TableHead key={column.key} className="text-center">
                      {column.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleVersions.map((version) => (
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
            <p className={`flex flex-wrap items-center gap-4 ${sectionFooterClass}`}>
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
      </Section>

      {events.length > 0 && (
        <Section title="Store incidents" description="When a store started failing, and when it recovered.">
          <ul>
            {events.slice(0, 10).map((e) => {
              const { text, raw } = describeEvent(e, events)
              return (
                <li key={e.id} className={`flex flex-wrap gap-x-4 gap-y-1 ${sectionRowClass}`}>
                  <span className="w-24 shrink-0 text-sm text-muted-foreground" title={relativeTime(e.createdAt)}>
                    {formatDate(e.createdAt)}
                  </span>
                  <div className="min-w-0 flex-[1_1_420px] space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{STORE_NAME[e.store]}</span>
                      <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${OPS_EVENT[e.type].className}`}>
                        {OPS_EVENT[e.type].label}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed">{text}</p>
                    {raw && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer select-none">Raw details</summary>
                        <pre className="mt-2 rounded-md border bg-muted/50 p-3 font-mono whitespace-pre-wrap break-all text-foreground">
                          {raw}
                        </pre>
                      </details>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </Section>
      )}
    </div>
  )
}

function ExtensionDetailLayout() {
  const { extensionId } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: extension, isPending } = useQuery(extensionQuery(extensionId))
  const [deleteOpen, setDeleteOpen] = useState(false)

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

  const copyId = () => {
    void navigator.clipboard.writeText(extension.id).then(
      () => toast.success('Extension ID copied'),
      () => toast.error('Couldn’t copy to the clipboard'),
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
          <Link to="/" className="hover:text-foreground">
            Extensions
          </Link>
          <span className="mx-2" aria-hidden="true">
            /
          </span>
          <span className="text-foreground">{extension.name}</span>
        </nav>
        <div className="flex flex-wrap items-start gap-4">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-bold tracking-tight">{extension.name}</h1>
            <div className="flex items-center gap-2 text-muted-foreground">
              <code className="text-xs">{extension.id}</code>
              <Button
                variant="outline"
                size="icon-sm"
                className="size-6"
                aria-label="Copy extension ID"
                onClick={copyId}
              >
                <Copy className="size-3" />
              </Button>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => reconcile.mutate()}
              disabled={reconcile.isPending}
              title="Check every store now and submit anything waiting (otherwise this runs every 30 minutes)"
            >
              {reconcile.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Sync now
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                  <Trash2 /> Delete extension
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
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

        {/* Real routes rather than tab state so both halves have copyable,
            deep-linkable URLs. */}
        <nav className="flex items-center gap-6 border-b text-sm font-medium">
          {(['publishing', 'licensing', 'analytics'] as const).map((section) => (
            <Link
              key={section}
              to={`/extensions/$extensionId/${section}`}
              params={{ extensionId }}
              className="-mb-px border-b-2 border-transparent py-2.5 text-muted-foreground transition-colors hover:text-foreground"
              activeProps={{ className: 'border-foreground! text-foreground' }}
            >
              {section === 'publishing' ? 'Publishing' : section === 'licensing' ? 'Licensing' : 'Analytics'}
            </Link>
          ))}
        </nav>
      </div>

      <Outlet />
    </div>
  )
}
