import type { MatrixExtension, MatrixTarget, SafariPlatform, Store, TargetLifecycle } from './api'
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
    return {
      action: {
        ...base,
        kind: 'error',
        label: 'Publishing failed',
        message: `${l.statusDetail ?? 'The last publish attempt failed.'} ${liveClause(l)}`,
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
