import { activitySeries, BROWSER_COLORS, byDate, lastNDays, shortDate } from '@/AnalyticsSection'
import { EmptyBox, PageHeader, Section, sectionBodyClass, sectionEmptyClass, StatTile } from '@/components/Section'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fleetAnalyticsExtensionsQuery, fleetAnalyticsOverviewQuery, fleetAnalyticsSeriesQuery } from '@/queries'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

export const Route = createFileRoute('/analytics')({ component: AnalyticsPage })

// isAnimationActive={false} on every series below — see AnalyticsSection.tsx's
// comment: unmemoized chart data + Recharts' enter animation is a real bug,
// not just unnecessary polish.

// The fleet-wide view: everything that stays meaningful once you stop
// looking at one extension. version/country/language/os breakdowns don't
// generalize across products (a version string means nothing outside the
// extension it belongs to), so the charts here only sum totals over time —
// per-extension distinction is a ranked list below, not more chart lines,
// since a line per extension stops being readable well before a real
// fleet's extension count.
function AnalyticsPage() {
  const { data: overview } = useQuery(fleetAnalyticsOverviewQuery)
  const { data: totalSeries, isPending } = useQuery(fleetAnalyticsSeriesQuery(30))
  const { data: extensions = [], isPending: extensionsPending } = useQuery(fleetAnalyticsExtensionsQuery)

  const totalRows = totalSeries?.rows ?? []
  const domain = totalSeries ? lastNDays(30, totalSeries.through) : []
  const daily = byDate(totalRows, domain)
  const activity = activitySeries(totalRows, domain)

  return (
    <div className="space-y-8">
      <PageHeader
        title="Analytics"
        description="Anonymous daily pings from every install, combined across all four stores."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Weekly active users"
          hint="rolling 7 days, same as the chart"
          value={overview ? String(overview.weeklyActives) : '—'}
        />
        <StatCard label="All-time installs" value={overview ? String(overview.allTimeInstalls) : '—'} />
        <StatCard label="Extensions reporting" value={overview ? String(overview.extensionsReporting) : '—'} />
      </div>

      {isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : totalRows.length === 0 ? (
        <EmptyBox title="No analytics yet">
          Counting starts once a release ships <code>@extport/sdk/analytics</code> (or the{' '}
          <code>@wxt-dev/analytics</code> provider) — one anonymous ping per install per day, nothing else.
        </EmptyBox>
      ) : (
        <>
          <Section
            title="Active users"
            description="Weekly actives (rolling 7 days) across every extension, one line per store. Days are UTC."
          >
            <div className={sectionBodyClass}>
              <ChartContainer
                config={
                  Object.fromEntries(
                    activity.browsers.map((b) => [b, { label: b, color: BROWSER_COLORS[b] }]),
                  ) satisfies ChartConfig
                }
                className="h-64 w-full"
              >
                <LineChart data={activity.data} margin={{ left: 4, right: 4 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tickFormatter={shortDate} minTickGap={32} />
                  <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  {activity.browsers.map((browser) => (
                    <Line
                      key={browser}
                      dataKey={browser}
                      stroke={`var(--color-${browser})`}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ChartContainer>
            </div>
          </Section>

          <Section
            title="Installs"
            description="Summed across every extension: one bar per day for installs first seen that day. Same-day exact."
          >
            <div className={sectionBodyClass}>
              <ChartContainer
                config={{
                  installs: { label: 'Installs', color: 'var(--chart-2)' },
                }}
                className="h-56 w-full"
              >
                <BarChart data={daily} margin={{ left: 4, right: 4 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tickFormatter={shortDate} minTickGap={32} />
                  <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey="installs"
                    fill="var(--color-installs)"
                    radius={2}
                    maxBarSize={40}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ChartContainer>
            </div>
          </Section>
        </>
      )}

      <Section title="By extension" description="Every extension reporting analytics, ranked by weekly actives.">
        {extensionsPending ? (
          <div className={sectionBodyClass}>
            <Skeleton className="h-32 w-full" />
          </div>
        ) : extensions.length === 0 ? (
          <p className={sectionEmptyClass}>No extensions reporting analytics yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Extension</TableHead>
                <TableHead>Weekly actives</TableHead>
                <TableHead>All-time installs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {extensions.map((e) => (
                <TableRow key={e.extensionId}>
                  <TableCell>
                    <Link
                      to="/extensions/$extensionId/analytics"
                      params={{ extensionId: e.extensionId }}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {e.name}
                    </Link>
                  </TableCell>
                  <TableCell>{e.weeklyActives}</TableCell>
                  <TableCell className="text-muted-foreground">{e.allTimeInstalls}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  )
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <StatTile label={label} value={value} hint={hint} />
}
