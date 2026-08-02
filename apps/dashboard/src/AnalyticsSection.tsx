import type { AnalyticsSeriesRow, Extension } from '@/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { analyticsOverviewQuery, analyticsSeriesQuery } from '@/queries'
import { useQuery } from '@tanstack/react-query'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

// The cross-store usage view — daily pings from @extport/sdk/analytics,
// rolled up server-side. Departures live on the last-seen day and are only
// written once confirmed (30 days of silence), so that chart's trailing
// month is legitimately empty. See docs/analytics-design.md.

// Every chart below sets isAnimationActive={false}. daily/dauByBrowser/
// versions are recomputed fresh on every render (not memoized), so any
// re-render during Recharts' enter animation — a StrictMode double-render,
// a background refetch — hands it a new data reference and restarts the
// animation from frame 0. Confirmed the hard way: with animation on, real
// data rendered as a permanently flat line at 0 (never got to progress past
// frame 0 before the next reset), even though the underlying data was
// correct the whole time.

/**
 * The fixed x-axis domain: the last N days ending *yesterday* — the last
 * fully-rolled-up day (CWS does the same: "to July 29" on July 30). Days
 * without data draw as 0 so every series is a continuous line across the
 * whole window, never a floating point.
 */
export function lastNDays(n: number): string[] {
  const days: string[] = []
  for (let i = n; i >= 1; i--) {
    days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
  }
  return days
}

/** Collapse per-browser rows into one point per domain day (installs/departures bars). */
export function byDate(rows: AnalyticsSeriesRow[], domain: string[]): { date: string; installs: number; departures: number }[] {
  const days = new Map(domain.map((date) => [date, { date, installs: 0, departures: 0 }]))
  for (const row of rows) {
    const day = days.get(row.date)
    if (!day) continue
    day.installs += row.installs
    day.departures += row.departures
  }
  return [...days.values()]
}

// One line per store is the chart no single store console can draw — fixed
// color per browser so chrome is the same color on every extension's page.
export const BROWSER_COLORS: Record<string, string> = {
  chrome: 'var(--chart-1)',
  firefox: 'var(--chart-2)',
  edge: 'var(--chart-3)',
  safari: 'var(--chart-4)',
  other: 'var(--chart-5)',
}
const BROWSER_ORDER = Object.keys(BROWSER_COLORS)

/**
 * Per-domain-day activity pivoted to one rolling-7-day-WAU column per
 * browser (the headline series — CWS's weekly users, plotted daily), plus a
 * `daily` column with total DAU across stores as the secondary diagnostic
 * line (still the most sensitive signal for "did today break").
 */
export function activitySeries(rows: AnalyticsSeriesRow[], domain: string[]): {
  data: Record<string, string | number>[]
  browsers: string[]
} {
  const browsers = BROWSER_ORDER.filter((b) => rows.some((r) => r.browser === b))
  const days = new Map<string, Record<string, string | number>>(
    domain.map((date) => [date, { date, daily: 0, ...Object.fromEntries(browsers.map((b) => [b, 0])) }]),
  )
  for (const row of rows) {
    const day = days.get(row.date)
    if (!day) continue
    day[row.browser] = ((day[row.browser] as number) ?? 0) + row.wau
    day['daily'] = (day['daily'] as number) + row.dau
  }
  return { data: [...days.values()], browsers }
}

const MAX_VERSION_SERIES = 8

/**
 * Chart config keys become CSS custom-property names (--color-<key>), which
 * can't contain dots or start with a digit — version strings need a safe
 * alias, with the real version kept as the label.
 */
function safeKey(version: string): string {
  return `v_${version.replace(/[^a-zA-Z0-9]/g, '_')}`
}

/** Per-domain-day dau per version (top N by latest-day usage, the tail as "other"), 0-filled. */
function versionSeries(rows: AnalyticsSeriesRow[], domain: string[]): {
  data: Record<string, string | number>[]
  series: { key: string; label: string }[]
} {
  if (rows.length === 0) return { data: [], series: [] }
  const lastDate = rows.reduce((max, r) => (r.date > max ? r.date : max), '')
  const latestUsage = new Map<string, number>()
  for (const row of rows) {
    if (row.date === lastDate) latestUsage.set(row.dimValue, (latestUsage.get(row.dimValue) ?? 0) + row.dau)
  }
  const ranked = [...new Set(rows.map((r) => r.dimValue))].sort(
    (a, b) => (latestUsage.get(b) ?? 0) - (latestUsage.get(a) ?? 0),
  )
  const top = ranked.slice(0, MAX_VERSION_SERIES)
  const hasOther = ranked.length > top.length
  // Newest version first in the ranking; render oldest at the bottom of the
  // stack so a release visually eats the layers above it.
  const series = [...top].reverse().map((version) => ({ key: safeKey(version), label: version }))
  if (hasOther) series.unshift({ key: 'other', label: 'other' })

  const days = new Map<string, Record<string, string | number>>(
    domain.map((date) => [date, { date, ...Object.fromEntries(series.map(({ key }) => [key, 0])) }]),
  )
  for (const row of rows) {
    const day = days.get(row.date)
    if (!day) continue
    const key = top.includes(row.dimValue) ? safeKey(row.dimValue) : 'other'
    day[key] = ((day[key] as number) ?? 0) + row.dau
  }
  return { data: [...days.values()], series }
}

export const shortDate = (value: string) => value.slice(5)

export function AnalyticsSection({ extension }: { extension: Extension }) {
  const { data: overview } = useQuery(analyticsOverviewQuery(extension.id))
  const { data: totalRows = [], isPending } = useQuery(analyticsSeriesQuery(extension.id, 'total'))
  const { data: versionRows = [] } = useQuery(analyticsSeriesQuery(extension.id, 'version'))

  const domain = lastNDays(30)
  const daily = byDate(totalRows, domain)
  const activity = activitySeries(totalRows, domain)
  const versions = versionSeries(versionRows, domain)

  // While the series loads, the zero-filled domain would render as a
  // convincing flat month of zeros — skeleton instead of a false signal.
  if (isPending) return <Skeleton className="h-48 w-full" />

  if (totalRows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No analytics yet</CardTitle>
          <CardDescription>
            Counting starts once a release ships <code>@extport/sdk/analytics</code> (or the{' '}
            <code>@wxt-dev/analytics</code> provider) — one anonymous ping per install per day, nothing else. Charts
            appear after the first nightly rollup.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Active installs" hint="seen in the last 30 days" value={overview ? String(overview.activeInstalls) : '—'} />
        <StatCard label="All-time installs" value={overview ? String(overview.allTimeInstalls) : '—'} />
        <StatCard
          label="Top version"
          hint="among active installs"
          value={
            overview && overview.versions[0]
              ? `${overview.versions[0].version} (${overview.activeInstalls > 0 ? Math.round((overview.versions[0].installs / overview.activeInstalls) * 100) : 0}%)`
              : '—'
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active users</CardTitle>
          <CardDescription>
            Weekly actives (rolling 7 days, same as the CWS console), one line per store — the view no single console
            can draw. The dashed line is daily actives across all stores, the sharpest signal for day-level breakage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer
            config={{
              ...Object.fromEntries(activity.browsers.map((b) => [b, { label: b, color: BROWSER_COLORS[b] }])),
              daily: { label: 'daily (all stores)', color: 'var(--muted-foreground)' },
            } satisfies ChartConfig}
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
              <Line
                dataKey="daily"
                stroke="var(--color-daily)"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Installs &amp; departures</CardTitle>
          <CardDescription>
            Installs are same-day exact. Departures sit on the day the install was last seen and only appear once
            confirmed by 30 days of silence — the most recent month is always blank, by design.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer
            config={{
              installs: { label: 'Installs', color: 'var(--chart-2)' },
              departures: { label: 'Departures', color: 'var(--chart-5)' },
            } satisfies ChartConfig}
            className="h-56 w-full"
          >
            <BarChart data={daily} margin={{ left: 4, right: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickFormatter={shortDate} minTickGap={32} />
              <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="installs" fill="var(--color-installs)" radius={2} maxBarSize={40} isAnimationActive={false} />
              <Bar dataKey="departures" fill="var(--color-departures)" radius={2} maxBarSize={40} isAnimationActive={false} />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Version saturation</CardTitle>
          <CardDescription>
            Daily actives by version — new releases eat the stack from below. The flip gate for anything riding an
            update is the top layer's share.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer
            config={Object.fromEntries(
              versions.series.map(({ key, label }, i) => [key, { label, color: `var(--chart-${(i % 5) + 1})` }]),
            )}
            className="h-64 w-full"
          >
            <AreaChart data={versions.data} margin={{ left: 4, right: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickFormatter={shortDate} minTickGap={32} />
              <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {versions.series.map(({ key }) => (
                <Area
                  key={key}
                  dataKey={key}
                  stackId="versions"
                  stroke={`var(--color-${key})`}
                  fill={`var(--color-${key})`}
                  fillOpacity={0.35}
                  type="monotone"
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ChartContainer>
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
        <p className="text-xl font-semibold tracking-tight">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}
