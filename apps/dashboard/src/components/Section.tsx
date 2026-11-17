import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

/**
 * One page section: heading on the page background, data in a single
 * bordered box underneath. Replaces Card-with-a-header on detail pages so
 * there's one frame per block instead of card border + header rule + table
 * rules stacked together.
 *
 * Alignment contract: everything inside the box sits on a 20px (px-5)
 * gutter. Plain rows should use `px-5` themselves; a <Table> dropped in is
 * nudged onto the same gutter automatically (first/last cells get pl-5/pr-5),
 * and its row dividers are softened so the box border stays the main line.
 *
 * The box keeps data-slot="card" so the root layout's phone rule (full-bleed,
 * no side borders) still applies to it.
 */
export function Section({
  title,
  description,
  action,
  children,
  className,
  id,
  'aria-label': ariaLabel,
}: {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned control next to the heading, e.g. "Add a store" or "Show all". */
  action?: ReactNode
  children: ReactNode
  className?: string
  /** Anchor id on the heading — docs deep-link to e.g. /settings#api-keys. */
  id?: string
  'aria-label'?: string
}) {
  return (
    <section className={cn('space-y-3', className)} aria-label={ariaLabel}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="space-y-0.5">
          <h2 id={id} className="scroll-mt-6 text-base font-semibold tracking-tight">
            {title}
          </h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      <div
        data-slot="card"
        className={cn(
          'overflow-hidden rounded-xl border bg-card text-card-foreground',
          // Tables: put first/last cells on the 20px gutter, soften inner rules.
          '[&_[data-slot=table-row]]:border-border/60',
          '[&_th:first-child]:pl-5 [&_td:first-child]:pl-5 [&_th:last-child]:pr-5 [&_td:last-child]:pr-5',
          '[&_th]:h-10 [&_td]:py-2.5',
        )}
      >
        {children}
      </div>
    </section>
  )
}

/** Row helper for non-table content inside a Section: same gutter, soft divider between rows. */
export const sectionRowClass = 'border-b border-border/60 px-5 py-3 last:border-b-0'

/** Footer strip inside a Section box (legends, hints). */
export const sectionFooterClass = 'border-t border-border/60 px-5 py-3 text-xs text-muted-foreground'

/** Empty-state text inside a Section box. */
export const sectionEmptyClass = 'px-5 py-6 text-sm text-muted-foreground'

/** Padded body inside a Section box, for non-tabular content (charts, forms, prose). */
export const sectionBodyClass = 'p-5'

/** Toolbar strip at the top of a Section box (search, filters) — sits above a table. */
export const sectionToolbarClass = 'flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3'

/** Page heading shared by top-level tenant pages (Extensions, Licenses, Analytics, Settings). */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  )
}

/** A box with just a heading and explanatory text — empty states that replace a whole section. */
export function EmptyBox({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div data-slot="card" className="space-y-1.5 rounded-xl border bg-card px-5 py-6">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {children && <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>}
    </div>
  )
}

/** Small metric tile (label, big number, optional hint) for KPI rows above a page's sections. */
export function StatTile({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div data-slot="card" className="space-y-1 rounded-xl border bg-card px-5 py-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tracking-tight">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
