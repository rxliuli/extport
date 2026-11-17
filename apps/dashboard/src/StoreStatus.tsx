import type { PublishTarget, Store, TargetLifecycle } from './api'
import { errorSummary, storeName } from './attention'
import { RawDetails } from './components/RawDetails'
import { Section, sectionRowClass } from './components/Section'
import { Skeleton } from './components/ui/skeleton'
import { targetsQuery, tenantSettingsQuery } from './queries'
import { ageDays, formatDate, formatElapsed } from './status'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

const DEFAULT_STALE_REVIEW_DAYS: Record<Store, number> = { chrome: 3, firefox: 3, edge: 10, safari: 3 }

const CONSOLE_LABEL: Record<Store, string> = {
  chrome: 'Developer Dashboard',
  firefox: 'Developer Hub',
  edge: 'Partner Center',
  safari: 'App Store Connect',
}

// progress is normal publishing (in review, queued) — blue, untinted, since
// it's how most stores sit for days; warn is reserved for what's drifted past
// a threshold (overdue review, expiring credential).
type Tone = 'ok' | 'progress' | 'warn' | 'bad' | 'off'

const PILL: Record<Tone, string> = {
  ok: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  progress: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  bad: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  off: 'bg-muted text-muted-foreground',
}
const PILL_DOT: Record<Tone, string> = {
  ok: 'bg-green-600 dark:bg-green-400',
  progress: 'bg-blue-500 dark:bg-blue-400',
  warn: 'bg-amber-500 dark:bg-amber-400',
  bad: 'bg-red-600 dark:bg-red-400',
  off: 'bg-muted-foreground/60',
}
// Healthy rows stay plain; only rows that need a look get a tint.
const ROW_TINT: Record<Tone, string> = {
  ok: '',
  progress: '',
  warn: 'bg-amber-50/70 dark:bg-amber-400/5',
  bad: 'bg-red-50/70 dark:bg-red-400/5',
  off: '',
}

interface Line {
  label: string
  version: string
  note?: string
  /** Hover text, e.g. the exact submission date behind "6 days". */
  title?: string
  tone?: 'progress' | 'warn' | 'bad'
}

function describe(
  target: PublishTarget,
  l: TargetLifecycle,
  staleDays: number,
): { tone: Tone; pill: string; lines: Line[]; detail: string | null; raw?: string | null } {
  const lines: Line[] = []
  if (l.liveVersion) lines.push({ label: 'Live', version: l.liveVersion })

  if (!target.enabled) {
    return {
      tone: target.disabledSource === 'auto' ? 'bad' : 'off',
      pill: target.disabledSource === 'auto' ? 'Paused' : 'Off',
      lines,
      detail:
        target.disabledReason ??
        (target.disabledSource === 'auto'
          ? 'Paused automatically after repeated rejections.'
          : 'Publishing to this store is turned off.'),
    }
  }
  if (target.credentialStatus === 'invalid') {
    return {
      tone: 'bad',
      pill: 'Credential invalid',
      lines,
      detail: `Replace the “${target.credentialLabel}” credential in Settings.`,
    }
  }

  const age = ageDays(l.submittedAt)
  const stale = !!l.inReviewVersion && age !== null && age >= staleDays
  if (l.inReviewVersion) {
    const since = l.submittedAt ? formatDate(l.submittedAt) : null
    lines.push({
      label: 'In review',
      version: l.inReviewVersion,
      note: l.submittedAt ? formatElapsed(l.submittedAt) : undefined,
      title: since ? `Submitted ${since}` : undefined,
      tone: stale ? 'warn' : 'progress',
    })
  }
  if (l.queuedVersion) {
    lines.push({
      label: 'Queued next',
      version: l.queuedVersion,
      note: l.inReviewVersion ? 'after this review' : undefined,
      tone: 'progress',
    })
  }
  if (l.rejectedVersion) lines.push({ label: 'Rejected', version: l.rejectedVersion, tone: 'bad' })

  if (l.status === 'error') {
    if (!l.error) return { tone: 'bad', pill: 'Publishing failed', lines, detail: l.statusDetail }
    const { summary, raw } = errorSummary(target.store, l.error)
    return { tone: 'bad', pill: 'Publishing failed', lines, detail: summary, raw }
  }
  if (l.status === 'rejected') return { tone: 'bad', pill: 'Rejected', lines, detail: l.statusDetail }
  if (l.inReviewVersion) {
    return {
      tone: stale ? 'warn' : 'progress',
      pill: stale ? 'Review overdue' : 'In review',
      lines,
      detail: stale ? `Past your ${staleDays}-day review threshold for this store.` : l.statusDetail,
    }
  }
  if (l.queuedVersion) return { tone: 'progress', pill: 'Queued', lines, detail: l.statusDetail }
  if (target.credentialStatus === 'expiring') {
    return {
      tone: 'warn',
      pill: 'Credential expiring',
      lines,
      detail: `Renew the “${target.credentialLabel}” credential in Settings.`,
    }
  }
  return { tone: 'ok', pill: 'Up to date', lines, detail: null }
}

/**
 * The answer to "where is this extension right now", one card per store
 * lifecycle (Safari gets one per platform). Sits at the top of Publishing;
 * the version history below it is the "how did we get here".
 */
export function StoreStatusSection({ extensionId }: { extensionId: string }) {
  const { data: targets, isPending } = useQuery(targetsQuery(extensionId))
  const { data: settings } = useQuery(tenantSettingsQuery)
  const staleReviewDays = settings?.staleReviewDays ?? DEFAULT_STALE_REVIEW_DAYS

  if (isPending) return <Skeleton className="h-32 w-full" />
  if (!targets || targets.length === 0) return null

  const rows = targets.flatMap((target) =>
    (target.lifecycles.length > 0 ? target.lifecycles : [null]).map((l) => ({ target, lifecycle: l })),
  )

  return (
    <Section title="Store status">
      <ul>
        {rows.map(({ target, lifecycle }) => {
          const info = lifecycle
            ? describe(target, lifecycle, staleReviewDays[target.store])
            : {
                tone: 'off' as Tone,
                pill: 'Nothing published',
                lines: [],
                detail: 'No version has gone through this store yet.',
              }
          const link = { href: lifecycle?.consoleUrl ?? target.consoleUrl, label: CONSOLE_LABEL[target.store] }
          return (
            <li
              key={`${target.id}:${lifecycle?.platform ?? ''}`}
              className={`grid gap-x-4 gap-y-1.5 sm:grid-cols-[9rem_10rem_minmax(0,1fr)_auto] sm:items-center ${sectionRowClass} ${ROW_TINT[info.tone]}`}
            >
              <span className="font-medium">{storeName(target.store, lifecycle?.platform ?? null)}</span>
              <span>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${PILL[info.tone]}`}
                >
                  <span className={`size-1.5 rounded-full ${PILL_DOT[info.tone]}`} aria-hidden="true" />
                  {info.pill}
                </span>
              </span>
              <span className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                {info.lines.map((line) => (
                  <span key={line.label} className="whitespace-nowrap" title={line.title}>
                    <span className="text-muted-foreground">{line.label} </span>
                    <span
                      className={`font-mono font-semibold ${
                        line.tone === 'progress'
                          ? 'text-blue-700 dark:text-blue-400'
                          : line.tone === 'warn'
                            ? 'text-amber-700 dark:text-amber-400'
                            : line.tone === 'bad'
                            ? 'text-red-700 dark:text-red-400'
                            : ''
                      }`}
                    >
                      {line.version}
                    </span>
                    {line.note && <span className="text-muted-foreground"> · {line.note}</span>}
                  </span>
                ))}
              </span>
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:justify-self-end"
              >
                {link.label} <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
              {info.detail && (
                <div className="space-y-1 sm:col-start-3 sm:col-end-5">
                  <p className="text-sm leading-relaxed text-muted-foreground">{info.detail}</p>
                  {'raw' in info && info.raw && <RawDetails text={info.raw} />}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
