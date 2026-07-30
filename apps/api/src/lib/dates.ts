/** UTC calendar day (YYYY-MM-DD) — the granularity of all analytics. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000)
}
