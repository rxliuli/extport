import type { MatrixExtension, MatrixTarget, SafariPlatform, Store, TargetError, TargetLifecycle } from './api'
import { ageDays, formatElapsed } from './status'

/**
 * Splits the fleet into "needs a human" vs "in flight" vs "fine", so the
 * Extensions page can lead with what to do instead of a wall of versions.
 *
 * Needs action = something extport cannot resolve by waiting: a rejection,
 * a failing publish, a bad credential, a review past the tenant's staleness
 * threshold, or an extension with nowhere to publish. Everything else that
 * isn't synced (reviews within threshold, queued pushes) is just in flight.
 */

export type ActionKind = 'rejected' | 'error' | 'credential' | 'stale_review' | 'not_set_up'

export interface ActionItem {
  extensionId: string
  extensionName: string
  store: Store | null
  platform: SafariPlatform | null
  kind: ActionKind
  /** Short status label, e.g. "Rejected" or "In review for 12 days". */
  label: string
  /** One sentence on what happened and what's live meanwhile. */
  message: string
  /** The raw store response behind `message`, for a collapsed disclosure. */
  raw?: string | null
  /** kind 'error' only: the structured failure, what groupActions keys on. */
  error?: TargetError | null
}

/**
 * Failures that share one cause — same store, same HTTP status, same store
 * error code — shown as one entry. A store outage hits every lifecycle on
 * that store at once; listing it once per extension buries anything else
 * that needs attention.
 */
export interface ActionGroup {
  store: Store
  summary: string
  raw: string | null
  items: ActionItem[]
}

export type ActionEntry = { type: 'item'; item: ActionItem } | { type: 'group'; group: ActionGroup }

/**
 * Collapses same-cause store errors into groups, in place of their first
 * member so the list order holds. Only store API responses group (they have
 * a status); extport-written errors stay one per lifecycle, as does a cause
 * that only one lifecycle has.
 */
export function groupActions(actions: ActionItem[]): ActionEntry[] {
  const entries: ActionEntry[] = []
  const groups = new Map<string, ActionGroup>()
  for (const item of actions) {
    const error = item.kind === 'error' ? item.error : null
    if (!error || error.status === null || !item.store) {
      entries.push({ type: 'item', item })
      continue
    }
    const key = `${item.store}:${error.status}:${error.code ?? ''}`
    let group = groups.get(key)
    if (!group) {
      group = { store: item.store, summary: errorSummary(item.store, error).summary, raw: error.message, items: [] }
      groups.set(key, group)
      entries.push({ type: 'group', group })
    }
    group.items.push(item)
  }
  return entries.map((e) => (e.type === 'group' && e.group.items.length === 1 ? { type: 'item', item: e.group.items[0]! } : e))
}

/** A group's members by extension, platforms merged: "Imp Translate (macOS, iOS)". */
export function affectedExtensions(group: ActionGroup): { extensionId: string; name: string; platforms: SafariPlatform[] }[] {
  const byId = new Map<string, { extensionId: string; name: string; platforms: SafariPlatform[] }>()
  for (const item of group.items) {
    let entry = byId.get(item.extensionId)
    if (!entry) {
      entry = { extensionId: item.extensionId, name: item.extensionName, platforms: [] }
      byId.set(item.extensionId, entry)
    }
    if (item.platform) entry.platforms.push(item.platform)
  }
  return [...byId.values()]
}

export function platformLabel(platform: SafariPlatform): string {
  return PLATFORM_LABEL[platform]
}

export interface InFlightItem {
  extensionId: string
  extensionName: string
  store: Store
  platform: SafariPlatform | null
  message: string
  /** When the pending version was submitted — oldest first in the list. Null for queued-only. */
  submittedAt: string | null
}

export type ExtensionHealth = 'action' | 'in_flight' | 'ok'

export interface FleetAttention {
  actions: ActionItem[]
  inFlight: InFlightItem[]
  health: Map<string, ExtensionHealth>
}

export const STORE_LABEL: Record<Store, string> = {
  chrome: 'Chrome',
  firefox: 'Firefox',
  edge: 'Edge',
  safari: 'Safari',
}
const PLATFORM_LABEL: Record<SafariPlatform, string> = { ios: 'iOS', macos: 'macOS' }

export function storeName(store: Store, platform: SafariPlatform | null): string {
  return platform ? `${STORE_LABEL[store]} (${PLATFORM_LABEL[platform]})` : STORE_LABEL[store]
}

// Who answered — the summary names the store's API, not extport.
const STORE_API: Record<Store, string> = {
  chrome: 'Chrome Web Store',
  firefox: 'addons.mozilla.org',
  edge: 'Partner Center',
  safari: 'App Store Connect',
}

// Past this, an extport-written message is probably carrying a store body
// too (a submit detail with no status) — still offer the full text.
const LONG_MESSAGE = 160

/**
 * A failed publish in one sentence. Store API failures are summarized from
 * their status and code — a 500 says "the store had a server error", not a
 * screenful of JSON — with the full response kept for the disclosure.
 * Everything else is a sentence extport wrote itself and is shown as is.
 */
export function errorSummary(store: Store, error: TargetError | null): { summary: string; raw: string | null } {
  if (!error) return { summary: 'The last publish attempt failed.', raw: null }
  if (error.status === null) {
    return { summary: error.message, raw: error.message.length > LONG_MESSAGE ? error.message : null }
  }
  const api = STORE_API[store]
  const what = error.code ? `${error.status} ${error.code}` : String(error.status)
  const summary =
    error.status >= 500
      ? `${api} returned a server error (${what}). The problem is on the store's side; extport keeps retrying.`
      : error.status === 429
        ? `${api} is rate limiting requests (${what}); extport keeps retrying.`
        : error.status === 401 || error.status === 403
          ? `${api} refused the credential (${what}). Check it in Settings.`
          : `${api} rejected a request (${what}).`
  return { summary, raw: error.message }
}

function liveClause(l: TargetLifecycle): string {
  return l.liveVersion ? `${l.liveVersion} is still live.` : 'Nothing is live on this store yet.'
}

function classifyLifecycle(
  ext: MatrixExtension,
  target: MatrixTarget,
  l: TargetLifecycle,
  staleReviewDays: Record<Store, number>,
  now: number,
): { action?: ActionItem; inFlight?: InFlightItem } {
  const base = { extensionId: ext.id, extensionName: ext.name, store: target.store, platform: l.platform }

  if (l.status === 'error') {
    // An API that predates `error` only has the text.
    const { summary, raw } = l.error
      ? errorSummary(target.store, l.error)
      : errorSummary(
          target.store,
          l.statusDetail ? { platform: null, status: null, code: null, message: l.statusDetail } : null,
        )
    return {
      action: {
        ...base,
        kind: 'error',
        label: 'Publishing failed',
        message: `${summary} ${liveClause(l)}`,
        raw,
        error: l.error,
      },
    }
  }
  if (l.status === 'rejected' && l.rejectedVersion) {
    return {
      action: {
        ...base,
        kind: 'rejected',
        label: 'Rejected',
        message: `${l.rejectedVersion} was rejected. ${liveClause(l)}${l.statusDetail ? ` ${l.statusDetail}` : ''}`,
      },
    }
  }

  const reviewing = l.inReviewVersion
  if (reviewing) {
    const age = l.submittedAt ? ageDays(l.submittedAt, now) : null
    const queuedClause = l.queuedVersion ? ` ${l.queuedVersion} is queued and goes out once this review finishes.` : ''
    if (age !== null && age >= staleReviewDays[target.store]) {
      return {
        action: {
          ...base,
          kind: 'stale_review',
          label: `In review for ${formatElapsed(l.submittedAt!, now)}`,
          message: `${reviewing} has been in review longer than your ${staleReviewDays[target.store]}-day threshold. ${liveClause(l)}${queuedClause}`,
        },
      }
    }
    return {
      inFlight: {
        ...base,
        store: target.store,
        message: `${reviewing} in review${l.submittedAt ? ` for ${formatElapsed(l.submittedAt, now)}` : ''}${l.queuedVersion ? ` · ${l.queuedVersion} queued` : ''}`,
        submittedAt: l.submittedAt,
      },
    }
  }
  if (l.queuedVersion) {
    return {
      inFlight: {
        ...base,
        store: target.store,
        message: `${l.queuedVersion} queued${l.statusDetail ? ` — ${l.statusDetail}` : ''}`,
        submittedAt: null,
      },
    }
  }
  return {}
}

export function classifyFleet(
  extensions: MatrixExtension[],
  staleReviewDays: Record<Store, number>,
  now: number = Date.now(),
): FleetAttention {
  const actions: ActionItem[] = []
  const inFlight: InFlightItem[] = []
  const health = new Map<string, ExtensionHealth>()

  for (const ext of extensions) {
    let state: ExtensionHealth = 'ok'
    const flag = (next: ExtensionHealth) => {
      if (next === 'action' || (next === 'in_flight' && state === 'ok')) state = next
    }

    if (ext.targets.length === 0) {
      actions.push({
        extensionId: ext.id,
        extensionName: ext.name,
        store: null,
        platform: null,
        kind: 'not_set_up',
        label: 'Not set up',
        message: 'No store targets yet, so pushes don’t publish anywhere.',
      })
      flag('action')
    }

    for (const target of ext.targets) {
      // A target the tenant switched off is a choice, not a problem.
      if (!target.enabled) continue
      if (target.credentialStatus !== 'active') {
        actions.push({
          extensionId: ext.id,
          extensionName: ext.name,
          store: target.store,
          platform: null,
          kind: 'credential',
          label: target.credentialStatus === 'invalid' ? 'Credential invalid' : 'Credential expiring',
          message:
            target.credentialStatus === 'invalid'
              ? `The “${target.credentialLabel}” credential no longer works, so nothing can publish here until it’s replaced in Settings.`
              : `The “${target.credentialLabel}” credential expires soon — renew it in Settings to keep publishing.`,
        })
        flag('action')
      }
      for (const l of target.lifecycles) {
        const result = classifyLifecycle(ext, target, l, staleReviewDays, now)
        if (result.action) {
          actions.push(result.action)
          flag('action')
        } else if (result.inFlight) {
          inFlight.push(result.inFlight)
          flag('in_flight')
        }
      }
    }
    health.set(ext.id, state)
  }

  const order: ActionKind[] = ['error', 'rejected', 'credential', 'stale_review', 'not_set_up']
  actions.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  // Longest-waiting review first; queued-only items (no submit time yet) last.
  inFlight.sort((a, b) => {
    if (a.submittedAt === b.submittedAt) return 0
    if (a.submittedAt === null) return 1
    if (b.submittedAt === null) return -1
    return a.submittedAt < b.submittedAt ? -1 : 1
  })
  return { actions, inFlight, health }
}
