import { api } from '@/api'
import { STORE_LABEL, storeName } from '@/attention'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { releasesQuery, type Release } from '@/queries'
import { relativeTime } from '@/status'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bell, Check, Link2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

// The header's release inbox: versions that went live on their baseline
// store (Chrome when targeted) and haven't been announced yet. Marking one
// announced is the tenant saying "posted it" — extport posts nothing itself.

const STATUS_LABEL: Record<Release['stores'][number]['status'], string> = {
  online: 'live',
  in_review: 'in review',
  queued: 'queued',
  rejected: 'rejected',
  skipped: 'skipped',
}

type Item = { extensionId: string; version: string }

export function ReleaseInbox() {
  const queryClient = useQueryClient()
  const { data } = useQuery(releasesQuery)
  const releases = data ?? []
  const pending = releases.filter((r) => !r.announcedAt)
  const announced = releases.filter((r) => r.announcedAt)

  const mark = useMutation({
    mutationFn: ({ items, value }: { items: Item[]; value: boolean }) =>
      api('/api/v1/releases/announced', { method: 'POST', body: JSON.stringify({ announced: value, items }) }),
    onMutate: async ({ items, value }) => {
      await queryClient.cancelQueries({ queryKey: releasesQuery.queryKey })
      const previous = queryClient.getQueryData(releasesQuery.queryKey)
      const keys = new Set(items.map((i) => `${i.extensionId}\0${i.version}`))
      const at = new Date().toISOString()
      queryClient.setQueryData(releasesQuery.queryKey, (old) =>
        old?.map((r) => (keys.has(`${r.extensionId}\0${r.version}`) ? { ...r, announcedAt: value ? at : null } : r)),
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      queryClient.setQueryData(releasesQuery.queryKey, ctx?.previous)
      toast.error('Could not update — try again.')
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: releasesQuery.queryKey }),
  })

  const setAnnounced = (items: Item[], value: boolean) => mark.mutate({ items, value })

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={pending.length ? `Releases, ${pending.length} not announced` : 'Releases'}
        >
          <Bell />
          {pending.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-4 font-semibold text-white">
              {pending.length > 9 ? '9+' : pending.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={16} className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <div className="text-sm font-semibold">Releases to announce</div>
            <div className="text-xs text-muted-foreground">Live on Chrome (or the first store without one)</div>
          </div>
          {pending.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => setAnnounced(pending.map(toItem), true)}
            >
              Mark all
            </Button>
          )}
        </div>
        <div className="max-h-[min(28rem,70vh)] overflow-y-auto">
          {pending.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              All caught up — nothing waiting to be announced.
            </p>
          ) : (
            <ul className="divide-y">
              {pending.map((r) => (
                <ReleaseRow key={`${r.extensionId}@${r.version}`} release={r} onToggle={setAnnounced} />
              ))}
            </ul>
          )}
          {announced.length > 0 && (
            <>
              <div className="border-t bg-muted/40 px-4 py-1.5 text-xs font-medium text-muted-foreground">
                Recently announced
              </div>
              <ul className="divide-y">
                {announced.map((r) => (
                  <ReleaseRow key={`${r.extensionId}@${r.version}`} release={r} onToggle={setAnnounced} />
                ))}
              </ul>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function toItem(r: Release): Item {
  return { extensionId: r.extensionId, version: r.version }
}

function ReleaseRow({ release: r, onToggle }: { release: Release; onToggle: (items: Item[], value: boolean) => void }) {
  const done = Boolean(r.announcedAt)
  // The other stores' state for this version — "Edge still in review" is
  // the context for announcing now vs. waiting.
  const others = r.stores.filter((s) => !(s.status === 'online' && s.store === 'chrome'))
  const copyLink = async () => {
    if (!r.listingUrl) return
    await navigator.clipboard.writeText(r.listingUrl)
    toast.success('Store link copied')
  }
  return (
    <li className={cn('flex items-start gap-3 px-4 py-3', done && 'opacity-60')}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <Link
          to="/extensions/$extensionId"
          params={{ extensionId: r.extensionId }}
          className="block truncate text-sm font-medium hover:underline"
        >
          {r.extensionName} <span className="font-mono text-xs text-muted-foreground">v{r.version}</span>
        </Link>
        <div className="text-xs text-muted-foreground">
          {done ? `Announced ${relativeTime(r.announcedAt!)}` : `Live ${relativeTime(r.onlineAt)}`}
        </div>
        {!done && others.length > 0 && (
          <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            {others.map((s) => (
              <span
                key={`${s.store}:${s.platform ?? ''}`}
                className={cn(s.status === 'online' && 'text-foreground/80')}
              >
                {s.platform ? storeName(s.store, s.platform) : STORE_LABEL[s.store]} {STATUS_LABEL[s.status]}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {r.listingUrl && !done && (
          <Button variant="ghost" size="icon-xs" aria-label="Copy store link" onClick={() => void copyLink()}>
            <Link2 />
          </Button>
        )}
        <Button
          variant={done ? 'ghost' : 'outline'}
          size="icon-xs"
          aria-label={done ? 'Mark not announced' : 'Mark announced'}
          onClick={() => onToggle([toItem(r)], !done)}
        >
          {done ? <RotateCcw /> : <Check />}
        </Button>
      </div>
    </li>
  )
}
