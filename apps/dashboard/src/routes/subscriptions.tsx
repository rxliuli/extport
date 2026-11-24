import type { SubscriptionStatusFilter } from '@/api'
import { PageHeader, Section, sectionEmptyClass, sectionToolbarClass, StatTile } from '@/components/Section'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAmount, LicenseBuyerCell, SubscriptionPlanCell, SubscriptionStatusCell } from '@/LicensingSection'
import { globalSubscriptionsQuery, subscriptionsOverviewQuery } from '@/queries'
import { formatDate } from '@/status'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/subscriptions')({ component: SubscriptionsPage })

type StatusFilter = 'all' | SubscriptionStatusFilter

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'trialing', label: 'Trialing' },
  { id: 'canceling', label: 'Canceling' },
  { id: 'past_due', label: 'Past due' },
  { id: 'canceled', label: 'Canceled' },
  { id: 'expired', label: 'Expired' },
]

// The cross-product view of every recurring subscription across all extensions —
// the support entry point when a subscriber writes in by email or account ID.
function SubscriptionsPage() {
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')

  useEffect(() => {
    const t = setTimeout(() => setSearch(input.trim()), 300)
    return () => clearTimeout(t)
  }, [input])

  const overview = useQuery(subscriptionsOverviewQuery)
  const pages = useInfiniteQuery(globalSubscriptionsQuery(search, status))
  const subscriptions = pages.data?.pages.flatMap((p) => p.subscriptions) ?? []

  const counts = overview.data?.counts
  const filterCount = (id: StatusFilter): number | undefined => {
    if (!counts) return undefined
    switch (id) {
      case 'all':
        return counts.total
      case 'active':
        return counts.active
      case 'trialing':
        return counts.trialing
      case 'canceling':
        return counts.canceling
      case 'past_due':
        return counts.pastDue
      case 'canceled':
        return counts.canceled
      case 'expired':
        return counts.expired
    }
  }

  const activeHintParts: string[] = []
  if (counts && counts.trialing > 0) activeHintParts.push(`${counts.trialing} trialing`)
  if (overview.data) {
    activeHintParts.push(`+${overview.data.newLast30d} new in last 30d`)
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Subscriptions" description="Recurring subscriptions across all your extensions." />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Est. MRR"
          value={overview.data ? formatAmount(overview.data.mrr, overview.data.currency) : '—'}
          hint={
            overview.data
              ? `${overview.data.counts.active} active${overview.data.hasMultipleCurrencies ? ` · ${overview.data.currency.toUpperCase()} only` : ''}`
              : undefined
          }
        />
        <StatTile
          label="Active"
          value={counts ? String(counts.active) : '—'}
          hint={activeHintParts.length > 0 ? activeHintParts.join(' · ') : undefined}
        />
        <StatTile label="Canceling" value={counts ? String(counts.canceling) : '—'} hint="ending at period end" />
        <StatTile
          label="Past due"
          value={counts ? String(counts.pastDue) : '—'}
          hint={counts && counts.pastDue > 0 ? 'payment retry needed' : 'all payments current'}
        />
      </div>

      <Section
        title="All subscriptions"
        description="Every recurring subscription across your extensions, newest first."
      >
        <div className={`${sectionToolbarClass} justify-between gap-3`}>
          <InputGroup className="max-w-md">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              id="subscriptions-search"
              name="search"
              aria-label="Search by buyer email or user ID"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search by buyer email or user ID"
            />
            {input && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  className="rounded-full"
                  aria-label="Clear search"
                  onClick={() => setInput('')}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter subscriptions by status">
            {STATUS_FILTERS.map((f) => {
              const count = filterCount(f.id)
              return (
                <Button
                  key={f.id}
                  size="sm"
                  variant={status === f.id ? 'default' : 'outline'}
                  className="rounded-full"
                  aria-pressed={status === f.id}
                  onClick={() => setStatus(f.id)}
                >
                  {f.label}
                  {count !== undefined && <span className="opacity-60">{count}</span>}
                </Button>
              )
            })}
          </div>
        </div>

        {subscriptions.length === 0 ? (
          <p className={sectionEmptyClass}>
            {pages.isPending
              ? 'Loading…'
              : search || status !== 'all'
                ? 'No subscription matches your filters.'
                : 'No subscriptions yet.'}
          </p>
        ) : (
          <Table aria-label="All subscriptions">
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscriptions.map((sub) => (
                <TableRow key={sub.id}>
                  <TableCell>
                    <LicenseBuyerCell buyerEmail={sub.buyerEmail} externalUserId={sub.externalUserId} />
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/extensions/$extensionId/licensing"
                      params={{ extensionId: sub.extensionId }}
                      className="underline-offset-4 hover:underline"
                    >
                      {sub.extensionName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <SubscriptionPlanCell tier={sub.tier} billingInterval={sub.billingInterval} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatAmount(sub.amountTotal, sub.currency)}</TableCell>
                  <TableCell>
                    <SubscriptionStatusCell sub={sub} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(sub.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {pages.hasNextPage && (
          <div className="flex justify-center border-t border-border/60 px-5 py-3">
            <Button
              variant="outline"
              size="sm"
              disabled={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              Show more
            </Button>
          </div>
        )}
      </Section>
    </div>
  )
}
