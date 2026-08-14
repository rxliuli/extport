import type { AnalyticsSeriesRow, Extension } from '@/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/extra/card'
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
import { Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, XAxis, YAxis } from 'recharts'

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
 * Per-domain-day rolling-7-day WAU pivoted to one column per browser —
 * CWS's weekly users, plotted daily.
 */
export function activitySeries(rows: AnalyticsSeriesRow[], domain: string[]): {
  data: Record<string, string | number>[]
  browsers: string[]
} {
  const browsers = BROWSER_ORDER.filter((b) => rows.some((r) => r.browser === b))
  const days = new Map<string, Record<string, string | number>>(
    domain.map((date) => [date, { date, ...Object.fromEntries(browsers.map((b) => [b, 0])) }]),
  )
  for (const row of rows) {
    const day = days.get(row.date)
    if (!day) continue
    day[row.browser] = ((day[row.browser] as number) ?? 0) + row.wau
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
  // Series membership must match the plotted metric. This chart draws dau,
  // but rollup rows also exist for wau-only days (the 7-day tail after a
  // version's last active day) — "any row in window" would admit a version
  // whose dau is zero across the entire window, rendering a permanently
  // flat baseline series that spends a top-N slot and a legend row on
  // nothing. Real case: a probe ping's wau echo kept a version ("1.0") no
  // user ever ran in the chart for weeks. Versions with dau somewhere in
  // the window keep their zero-filled dead days below — that fill is what
  // lets the area geometry collapse continuously to the baseline.
  const windowDau = new Map<string, number>()
  for (const row of rows) windowDau.set(row.dimValue, (windowDau.get(row.dimValue) ?? 0) + row.dau)
  rows = rows.filter((r) => (windowDau.get(r.dimValue) ?? 0) > 0)
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
  // Stack/legend order is the actual version number (oldest at the bottom,
  // so a release visually eats the layers above it) — not the popularity
  // rank used to pick `top` above. A fresh release starts out least-used, so
  // sorting by popularity here would misplace it — and read confusingly out
  // of order — until adoption catches up.
  const series = [...top].sort(compareVersions).map((version) => ({ key: safeKey(version), label: version }))
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

/**
 * Latest-day WAU per dimension value, top N with the tail folded into an
 * Other row (value: null). Reads wau, not dau, so a value active this week
 * but quiet yesterday still shows — same semantics as the CWS console's
 * "weekly users by" charts.
 */
export function dimensionShares(rows: AnalyticsSeriesRow[], topN = 5): { value: string | null; wau: number; share: number }[] {
  const lastDate = rows.reduce((max, r) => (r.date > max ? r.date : max), '')
  const byValue = new Map<string, number>()
  for (const row of rows) {
    if (row.date === lastDate && row.wau > 0) byValue.set(row.dimValue, (byValue.get(row.dimValue) ?? 0) + row.wau)
  }
  const ranked = [...byValue.entries()].sort((a, b) => b[1] - a[1])
  const total = ranked.reduce((sum, [, wau]) => sum + wau, 0)
  if (total === 0) return []
  const top = ranked.slice(0, topN)
  const otherWau = total - top.reduce((sum, [, wau]) => sum + wau, 0)
  const shares: { value: string | null; wau: number; share: number }[] = top.map(([value, wau]) => ({ value, wau, share: wau / total }))
  if (otherWau > 0) shares.push({ value: null, wau: otherWau, share: otherWau / total })
  return shares
}

// Human labels via Intl.DisplayNames — the codes themselves stay raw in
// the rollup ('us', 'en-us'); presentation is the only place names live.
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
const languageNames = new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' })
export function countryLabel(code: string): string {
  if (code === 'unknown') return 'Unknown'
  try {
    return regionNames.of(code.toUpperCase()) ?? code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}
export function languageLabel(code: string): string {
  if (code === 'unknown') return 'Unknown'
  try {
    return languageNames.of(code) ?? code
  } catch {
    return code
  }
}
const OS_LABELS: Record<string, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', chromeos: 'ChromeOS', ios: 'iOS', unknown: 'Unknown' }
export const osLabel = (value: string) => OS_LABELS[value] ?? value

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

export function AnalyticsSection({ extension }: { extension: Extension }) {
  const { data: overview } = useQuery(analyticsOverviewQuery(extension.id))
  const { data: totalRows = [], isPending } = useQuery(analyticsSeriesQuery(extension.id, 'total'))
  const { data: versionRows = [] } = useQuery(analyticsSeriesQuery(extension.id, 'version'))
  const { data: countryRows = [] } = useQuery(analyticsSeriesQuery(extension.id, 'country', 7))
  const { data: languageRows = [] } = useQuery(analyticsSeriesQuery(extension.id, 'language', 7))
  const { data: osRows = [] } = useQuery(analyticsSeriesQuery(extension.id, 'os', 7))

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
      <div className="grid gap-4 *:min-w-0 sm:grid-cols-3">
        <StatCard label="Weekly active users" hint="rolling 7 days, same as the chart" value={overview ? String(overview.weeklyActives) : '—'} />
        <StatCard label="All-time installs" value={overview ? String(overview.allTimeInstalls) : '—'} />
        <StatCard
          label="Latest version adoption"
          hint="share of weekly actives on it"
          value={
            overview && overview.versions.length > 0
              ? (() => {
                  const latest = overview.versions.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a))
                  const pct = overview.weeklyActives > 0 ? Math.round((latest.weeklyUsers / overview.weeklyActives) * 100) : 0
                  return `${latest.version} (${pct}%)`
                })()
              : '—'
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active users</CardTitle>
          <CardDescription>
            Weekly actives (rolling 7 days, same as the CWS console), one line per store — the view no single console
            can draw. Days are UTC.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer
            config={Object.fromEntries(
              activity.browsers.map((b) => [b, { label: b, color: BROWSER_COLORS[b] }]),
            ) satisfies ChartConfig}
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
        </CardContent>
      </Card>

      <div className="grid gap-6 *:min-w-0 lg:grid-cols-3">
        <BreakdownCard title="Weekly users by country" rows={countryRows} format={countryLabel} />
        <BreakdownCard title="Weekly users by language" rows={languageRows} format={languageLabel} />
        <BreakdownCard title="Weekly users by OS" rows={osRows} format={osLabel} />
      </div>

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

function BreakdownCard({
  title,
  rows,
  format,
}: {
  title: string
  rows: AnalyticsSeriesRow[]
  format: (value: string) => string
}) {
  const data = dimensionShares(rows).map((s) => ({
    name: s.value === null ? 'Other' : format(s.value),
    wau: s.wau,
    share: `${Math.round(s.share * 100)}%`,
  }))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>Rolling 7 days, latest rolled-up day</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data yet.</p>
        ) : (
          <ChartContainer
            config={{ wau: { label: 'Weekly users', color: 'var(--chart-1)' } } satisfies ChartConfig}
            className="h-52 w-full"
          >
            <BarChart data={data} layout="vertical" margin={{ left: 0, right: 32 }}>
              <XAxis type="number" hide />
              <YAxis
                dataKey="name"
                type="category"
                tickLine={false}
                axisLine={false}
                width={104}
                tickFormatter={(value: string) => (value.length > 15 ? `${value.slice(0, 14)}…` : value)}
              />
              <ChartTooltip content={<ChartTooltipContent />} cursor={false} />
              <Bar dataKey="wau" fill="var(--color-wau)" radius={4} maxBarSize={20} isAnimationActive={false}>
                <LabelList dataKey="share" position="right" className="fill-foreground text-xs" />
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
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
