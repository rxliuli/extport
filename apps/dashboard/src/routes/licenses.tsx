import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DevicesDialog, formatAmount } from '@/LicensingSection'
import { globalLicensesQuery, licensesSummaryQuery } from '@/queries'
import { formatDate } from '@/status'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'

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
  const summary = useQuery(licensesSummaryQuery)
  const pages = useInfiniteQuery(globalLicensesQuery(search))
  const licenses = pages.data?.pages.flatMap((p) => p.licenses) ?? []

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Licenses</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Licenses" value={summary.data ? String(summary.data.licenses) : '—'} />
        <StatCard label="Active" value={summary.data ? String(summary.data.active) : '—'} />
        {(summary.data?.revenue ?? []).map((r) => (
          <StatCard
            key={r.currency}
            label={`Revenue (${r.currency.toUpperCase()})`}
            value={formatAmount(r.total, r.currency)}
            hint={`${formatAmount(r.last30d, r.currency)} in the last 30 days`}
          />
        ))}
      </div>

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

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}
