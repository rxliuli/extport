import type { AnalyticsSeriesRow, Extension } from '@/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { analyticsOverviewQuery, analyticsSeriesQuery } from '@/queries'
import { useQuery } from '@tanstack/react-query'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

// The cross-store usage view — daily pings from @extport/sdk/analytics,
// rolled up server-side. Departures live on the last-seen day and are only
// written once confirmed (30 days of silence), so that chart's trailing
// month is legitimately empty. See docs/analytics-design.md.

/** Collapse per-browser rows into one point per day. */
function byDate(rows: AnalyticsSeriesRow[]): { date: string; dau: number; mau: number; installs: number; departures: number }[] {
  const days = new Map<string, { date: string; dau: number; mau: number; installs: number; departures: number }>()
  for (const row of rows) {
    const day = days.get(row.date) ?? { date: row.date, dau: 0, mau: 0, installs: 0, departures: 0 }
    day.dau += row.dau
    day.mau += row.mau
    day.installs += row.installs
    day.departures += row.departures
    days.set(row.date, day)
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
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

/** Per-day dau per version (top N by latest-day usage, the tail as "other"). */
function versionSeries(rows: AnalyticsSeriesRow[]): {
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

  const days = new Map<string, Record<string, string | number>>()
  for (const row of rows) {
    const day = days.get(row.date) ?? { date: row.date }
    const series = top.includes(row.dimValue) ? safeKey(row.dimValue) : 'other'
    day[series] = ((day[series] as number) ?? 0) + row.dau
    days.set(row.date, day)
  }
  // Newest version first in the ranking; render oldest at the bottom of the
  // stack so a release visually eats the layers above it.
  const series = [...top].reverse().map((version) => ({ key: safeKey(version), label: version }))
  if (hasOther) series.unshift({ key: 'other', label: 'other' })
  return { data: [...days.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))), series }
}

const shortDate = (value: string) => value.slice(5)

export function AnalyticsSection({ extension }: { extension: Extension }) {
  const { data: overview } = useQuery(analyticsOverviewQuery(extension.id))
  const { data: totalRows = [], isPending } = useQuery(analyticsSeriesQuery(extension.id, 'total'))
  const { data: versionRows = [] } = useQuery(analyticsSeriesQuery(extension.id, 'version'))

  const daily = byDate(totalRows)
  const versions = versionSeries(versionRows)

  if (!isPending && daily.length === 0) {
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active installs" hint="seen in the last 30 days" value={overview ? String(overview.activeInstalls) : '—'} />
        <StatCard label="All-time installs" value={overview ? String(overview.allTimeInstalls) : '—'} />
        <StatCard
          label="Browsers"
          value={
            overview && overview.browsers.length > 0
              ? overview.browsers.map((b) => `${b.browser} ${b.installs}`).join(' · ')
              : '—'
          }
        />
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
          <CardDescription>Daily and rolling 30-day actives, all stores combined.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer
            config={{
              dau: { label: 'DAU', color: 'var(--chart-1)' },
              mau: { label: 'MAU', color: 'var(--chart-2)' },
            } satisfies ChartConfig}
            className="h-64 w-full"
          >
            <LineChart data={daily} margin={{ left: 4, right: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickFormatter={shortDate} minTickGap={32} />
              <YAxis tickLine={false} axisLine={false} width={40} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Line dataKey="dau" stroke="var(--color-dau)" strokeWidth={2} dot={false} />
              <Line dataKey="mau" stroke="var(--color-mau)" strokeWidth={2} dot={false} />
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
              <Bar dataKey="installs" fill="var(--color-installs)" radius={2} />
              <Bar dataKey="departures" fill="var(--color-departures)" radius={2} />
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
