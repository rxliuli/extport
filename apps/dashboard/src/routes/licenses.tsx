import { shortDate } from '@/AnalyticsSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DevicesDialog, formatAmount } from '@/LicensingSection'
import { globalLicensesQuery, licensesOverviewQuery, type LicensesOverview } from '@/queries'
import { formatDate } from '@/status'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

export const Route = createFileRoute('/licenses')({ component: LicensesPage })

// The cross-product view of every activation code the tenant has ever sold
// or issued — the entry point for support ("my code doesn't work") where
// the buyer's email is known but which product they bought isn't. Issuing
// stays on each extension's Licensing tab, where the plan context lives.
function LicensesPage() {
  const [input, setInput] = useState('')
  // Debounced into the query key — the API matches substrings, so typing
  // filters live; clearing the input restores the full list the same way.
  const [search, setSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearch(input.trim()), 300)
    return () => clearTimeout(t)
  }, [input])
  const overview = useQuery(licensesOverviewQuery)
  const pages = useInfiniteQuery(globalLicensesQuery(search))
  const licenses = pages.data?.pages.flatMap((p) => p.licenses) ?? []

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Licenses</h2>

      {overview.data && (
        <div className="grid gap-6 lg:grid-cols-2">
          <TrendCard
            title="Revenue"
            overview={overview.data}
            metric="revenue"
            format={(v) => formatAmount(v, overview.data.currency)}
          />
          <TrendCard title="Licenses sold" overview={overview.data} metric="count" format={String} />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All licenses</CardTitle>
          <CardDescription>Every license across your extensions, newest first.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <InputGroup className="max-w-md">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search by activation code or buyer email"
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

          {licenses.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {pages.isPending ? 'Loading…' : search ? 'No license matches your search.' : 'No licenses yet.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Buyer</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {licenses.map((license) => (
                  <TableRow key={license.id}>
                    <TableCell>
                      <code className="text-xs">{license.key}</code>
                    </TableCell>
                    <TableCell>
                      <Link
                        to="/extensions/$extensionId/licensing"
                        params={{ extensionId: license.extensionId }}
                        className="underline-offset-4 hover:underline"
                      >
                        {license.extensionName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{license.tier}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{license.buyerEmail}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatAmount(license.amountTotal, license.currency)}
                    </TableCell>
                    <TableCell>
                      {license.status === 'active' ? (
                        <span className="text-muted-foreground">active</span>
                      ) : (
                        <Badge variant="destructive">{license.status}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{license.source.replace('_webhook', '')}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(license.createdAt)}</TableCell>
                    <TableCell>
                      <DevicesDialog license={license} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {pages.hasNextPage && (
            <div className="flex justify-center">
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
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Paddle-style period comparison: this-period solid line over a
 * previous-period dashed line, index-aligned (each day drawn on top of the
 * day 30 back), headline total + delta% in the header.
 */
function TrendCard({
  title,
  overview,
  metric,
  format,
}: {
  title: string
  overview: LicensesOverview
  metric: 'revenue' | 'count'
  format: (value: number) => string
}) {
  const data = overview.days.map((d) => ({
    date: d.date,
    current: metric === 'revenue' ? d.revenue : d.count,
    previous: metric === 'revenue' ? d.prevRevenue : d.prevCount,
  }))
  const total = metric === 'revenue' ? overview.totals.revenue : overview.totals.count
  const prevTotal = metric === 'revenue' ? overview.totals.prevRevenue : overview.totals.prevCount
  const delta = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-2xl font-semibold tracking-tight">{format(total)}</p>
        <CardDescription>
          {delta !== null ? (
            <>
              <span className={delta < 0 ? 'text-destructive' : 'text-primary'}>
                {delta >= 0 ? '+' : ''}
                {delta.toFixed(1)}%
              </span>{' '}
              vs. {format(prevTotal)} previous 30 days
            </>
          ) : (
            'Last 30 days — no sales in the 30 days before'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={{
            current: { label: 'Last 30 days', color: 'var(--chart-1)' },
            previous: { label: 'Previous 30 days', color: 'var(--muted-foreground)' },
          } satisfies ChartConfig}
          className="h-48 w-full"
        >
          <LineChart data={data} margin={{ left: 4, right: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickFormatter={shortDate} minTickGap={32} />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={metric === 'revenue' ? 56 : 32}
              allowDecimals={false}
              tickFormatter={metric === 'revenue' ? (v: number) => format(v) : undefined}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  // Values are smallest-currency-unit integers; the default
                  // renderer would print raw cents.
                  formatter={(value, name) => (
                    <div className="flex flex-1 items-center justify-between gap-4 leading-none">
                      <span className="text-muted-foreground">
                        {name === 'current' ? 'Last 30 days' : 'Previous 30 days'}
                      </span>
                      <span className="font-mono font-medium tabular-nums">{format(Number(value))}</span>
                    </div>
                  )}
                />
              }
            />
            <Line dataKey="current" stroke="var(--color-current)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line
              dataKey="previous"
              stroke="var(--color-previous)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
