import { useEffect, useState } from 'react'
import {
  api,
  ApiError,
  type CredentialRow,
  type DeploymentVersion,
  type Extension,
  type PublishEvent,
  type PublishTarget,
  type Store,
} from './api'
import { STATUS_COLOR } from './status'
import { VersionSummary } from './VersionSummary'

const STORES: Store[] = ['chrome', 'firefox', 'edge', 'safari']

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function TargetsSection({ extensionId }: { extensionId: string }) {
  const [targets, setTargets] = useState<PublishTarget[]>([])
  const [credentials, setCredentials] = useState<CredentialRow[]>([])
  const [store, setStore] = useState<Store>('chrome')
  const [credentialId, setCredentialId] = useState('')
  const [storeItemId, setStoreItemId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reload = () => api<{ targets: PublishTarget[] }>(`/v1/extensions/${extensionId}/targets`).then((r) => setTargets(r.targets))

  useEffect(() => {
    void reload()
    void api<{ credentials: CredentialRow[] }>('/v1/credentials').then((r) => setCredentials(r.credentials))
  }, [extensionId])

  const availableStores = STORES.filter((s) => !targets.some((t) => t.store === s))
  // `store` can point at a store that's no longer available (chrome already
  // configured by the time this mounts, or just added via this same form) —
  // the <select> then silently shows its first <option> while `store` stays
  // stale, desyncing the credential list from what's visually selected.
  const selectedStore = availableStores.includes(store) ? store : (availableStores[0] ?? store)
  const matchingCredentials = credentials.filter((c) => c.store === selectedStore)
  // Same idea as selectedStore: default to the first (often only) match
  // instead of making the tenant re-pick something that isn't actually a choice.
  const selectedCredentialId = matchingCredentials.some((c) => c.id === credentialId) ? credentialId : (matchingCredentials[0]?.id ?? '')

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api(`/v1/extensions/${extensionId}/targets`, {
        method: 'POST',
        body: JSON.stringify({ store: selectedStore, credentialId: selectedCredentialId, storeItemId }),
      })
      setStoreItemId('')
      setCredentialId('')
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const toggle = async (target: PublishTarget) => {
    await api(`/v1/extensions/${extensionId}/targets/${target.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !target.enabled }),
    })
    await reload()
  }

  const remove = async (target: PublishTarget) => {
    await api(`/v1/extensions/${extensionId}/targets/${target.id}`, { method: 'DELETE' })
    await reload()
  }

  return (
    <section>
      <h3>Store targets</h3>
      <table cellPadding={6} style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
            <th>Store</th>
            <th>Item ID</th>
            <th>Credential</th>
            <th>Version</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {targets.map((t) => {
            return (
              <tr key={t.id} style={{ borderBottom: '1px solid #eee' }}>
                <td>{t.store}</td>
                <td>
                  <code>{t.storeItemId}</code>
                </td>
                <td>
                  {t.credentialLabel}{' '}
                  {t.credentialStatus !== 'active' && <span style={{ color: 'crimson' }}>({t.credentialStatus})</span>}
                </td>
                <td>
                  <VersionSummary target={t} />
                </td>
                <td>{t.enabled ? 'enabled' : 'disabled'}</td>
                <td>
                  <button onClick={() => void toggle(t)}>{t.enabled ? 'Disable' : 'Enable'}</button>{' '}
                  <button onClick={() => void remove(t)}>Remove</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {targets.length === 0 && <p>No stores configured yet.</p>}

      {availableStores.length > 0 && (
        <>
          <h4>Add a store</h4>
          <form onSubmit={add} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={selectedStore}
              onChange={(e) => {
                setStore(e.target.value as Store)
                setCredentialId('')
              }}
            >
              {availableStores.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select value={selectedCredentialId} onChange={(e) => setCredentialId(e.target.value)} required>
              <option value="" disabled>
                Select credential…
              </option>
              {matchingCredentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} (…{c.hint})
                </option>
              ))}
            </select>
            <input
              value={storeItemId}
              onChange={(e) => setStoreItemId(e.target.value)}
              placeholder="Store item id"
              required
            />
            <button type="submit" disabled={matchingCredentials.length === 0}>
              Add
            </button>
          </form>
          {matchingCredentials.length === 0 && (
            <p style={{ fontSize: 13, color: '#666' }}>
              No {selectedStore} credential yet — add one in Settings → Store credentials first.
            </p>
          )}
        </>
      )}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </section>
  )
}

const VERSION_STATUS_LABEL: Record<DeploymentVersion['status'], string> = {
  queued: 'queued',
  in_review: 'in review',
  online: 'live',
  rejected: 'rejected',
  skipped: 'skipped',
}

const VERSION_STATUS_COLOR: Record<DeploymentVersion['status'], string> = {
  queued: '#9a6700',
  in_review: '#9a6700',
  online: '#1a7f37',
  rejected: '#cf222e',
  skipped: '#6e7781',
}

const EVENT_LABEL: Record<PublishEvent['type'], string> = {
  error: 'error',
  stale_review: 'stale review',
}

const EVENT_COLOR: Record<PublishEvent['type'], string> = {
  error: '#cf222e',
  stale_review: '#9a6700',
}

function eventDetail(event: PublishEvent): string | null {
  const payload = JSON.parse(event.payloadJson) as Record<string, unknown>
  if (event.type === 'error') return typeof payload.message === 'string' ? payload.message : null
  const version = typeof payload.version === 'string' ? ` v${payload.version}` : ''
  return `${payload.ageDays}+ days${version}`
}

// The Timeline is deployment_versions (every push, and what happened to it —
// queued/in_review/online/rejected/skipped all live on one row that mutates
// in place) merged with publish_events (only error/stale_review, which
// aren't about any one version) and sorted by time. "Current state" lives
// entirely in the Store targets table above; this is purely history.
type TimelineRow =
  | { kind: 'version'; id: string; store: Store; createdAt: string; version: DeploymentVersion }
  | { kind: 'event'; id: string; store: Store; createdAt: string; event: PublishEvent }

function TimelineSection({ extensionId }: { extensionId: string }) {
  const [rows, setRows] = useState<TimelineRow[]>([])

  useEffect(() => {
    void api<{ versions: DeploymentVersion[]; events: PublishEvent[] }>(`/v1/extensions/${extensionId}/timeline`).then((r) => {
      const merged: TimelineRow[] = [
        ...r.versions.map((v): TimelineRow => ({ kind: 'version', id: v.id, store: v.store, createdAt: v.createdAt, version: v })),
        ...r.events.map((e): TimelineRow => ({ kind: 'event', id: e.id, store: e.store, createdAt: e.createdAt, event: e })),
      ]
      merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      setRows(merged)
    })
  }, [extensionId])

  return (
    <section>
      <h3>Timeline</h3>
      {rows.length === 0 && <p>No activity yet.</p>}
      {rows.length > 0 && (
        <table cellPadding={6} style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
              <th>Time</th>
              <th>Store</th>
              <th>Version</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ color: '#666', fontSize: 12, whiteSpace: 'nowrap' }}>{relativeTime(row.createdAt)}</td>
                <td>{row.store}</td>
                <td>{row.kind === 'version' ? <code>{row.version.version}</code> : '—'}</td>
                <td>
                  {row.kind === 'version' ? (
                    <>
                      <span style={{ color: VERSION_STATUS_COLOR[row.version.status], fontWeight: 600 }}>
                        {VERSION_STATUS_LABEL[row.version.status]}
                      </span>
                      {row.version.statusDetail && <div style={{ fontSize: 12, color: '#666' }}>{row.version.statusDetail}</div>}
                    </>
                  ) : (
                    <>
                      <span style={{ color: EVENT_COLOR[row.event.type], fontWeight: 600 }}>{EVENT_LABEL[row.event.type]}</span>
                      <div style={{ fontSize: 12, color: '#666' }}>{eventDetail(row.event)}</div>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function ExtensionDetailPage({ extensionId, onBack }: { extensionId: string; onBack: () => void }) {
  const [extension, setExtension] = useState<Extension | null>(null)
  const [tab, setTab] = useState<'publishing' | 'licensing'>('publishing')
  const [reconciling, setReconciling] = useState(false)
  const [reconcileResult, setReconcileResult] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const reloadExtension = () =>
    api<{ extension: Extension }>(`/v1/extensions/${extensionId}`).then((r) => setExtension(r.extension))

  useEffect(() => {
    void reloadExtension()
  }, [extensionId])

  const togglePublishing = async () => {
    if (!extension) return
    await api(`/v1/extensions/${extensionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ publishingEnabled: !extension.publishingEnabled }),
    })
    await reloadExtension()
  }

  const reconcileNow = async () => {
    setReconciling(true)
    setReconcileResult(null)
    try {
      const res = await api<{ summary: { processed: number; submitted: number; blocked: number; errors: number } }>(
        `/v1/extensions/${extensionId}/reconcile`,
        { method: 'POST' },
      )
      const s = res.summary
      setReconcileResult(`processed ${s.processed} · submitted ${s.submitted} · blocked ${s.blocked} · errors ${s.errors}`)
      setRefreshKey((k) => k + 1)
    } catch (err) {
      setReconcileResult(err instanceof ApiError ? err.message : String(err))
    } finally {
      setReconciling(false)
    }
  }

  const deleteExtension = async () => {
    if (!extension) return
    if (!confirm(`Delete "${extension.name}"? This removes all its artifacts, store targets, and history. This can't be undone.`)) {
      return
    }
    await api(`/v1/extensions/${extensionId}`, { method: 'DELETE' })
    onBack()
  }

  if (!extension) return <p>Loading…</p>

  return (
    <section>
      <button onClick={onBack} style={{ marginBottom: 12 }}>
        ← Back
      </button>
      <h2 style={{ marginBottom: 4 }}>{extension.name}</h2>
      <p style={{ color: '#666', marginTop: 0 }}>
        <code>{extension.slug}</code>
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={() => void togglePublishing()}>
          Publishing: {extension.publishingEnabled ? 'ON' : 'OFF'} (toggle)
        </button>
        <button onClick={() => void reconcileNow()} disabled={reconciling}>
          {reconciling ? 'Reconciling…' : 'Reconcile now'}
        </button>
        <button onClick={() => void deleteExtension()} style={{ marginLeft: 'auto', color: '#cf222e' }}>
          Delete extension
        </button>
      </div>
      {reconcileResult && <p style={{ fontSize: 13 }}>{reconcileResult}</p>}

      <div style={{ background: '#f6f6f6', padding: 12, borderRadius: 6, marginBottom: 16 }}>
        <p style={{ marginTop: 0, marginBottom: 4 }}>Upload artifacts for this extension from CI:</p>
        <pre style={{ overflowX: 'auto', margin: 0 }}>
          {`npx extport push dist.zip --extension ${extension.slug} --version 1.2.3\n`}
          {`# EXTPORT_API_KEY must be set (Settings → API keys)`}
        </pre>
      </div>

      <nav style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <button onClick={() => setTab('publishing')} disabled={tab === 'publishing'}>
          Publishing
        </button>
        <button onClick={() => setTab('licensing')} disabled={tab === 'licensing'}>
          Licensing
        </button>
      </nav>

      {tab === 'publishing' ? (
        <div key={refreshKey}>
          <TargetsSection extensionId={extensionId} />
          <TimelineSection extensionId={extensionId} />
        </div>
      ) : (
        <p style={{ color: STATUS_COLOR.blocked }}>
          Licensing is coming in Phase 2. Interested? Let us know and we'll notify you when it ships.
        </p>
      )}
    </section>
  )
}
