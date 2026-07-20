import { useEffect, useState } from 'react'
import { api, ApiError, type CredentialRow, type Extension, type PublishEvent, type PublishTarget, type Store } from './api'
import { STATUS_COLOR } from './status'

const STORES: Store[] = ['chrome', 'firefox', 'edge', 'apple']

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const EVENT_LABEL: Record<PublishEvent['type'], string> = {
  submitted: 'submitted',
  approved: 'live',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
  blocked: 'blocked',
  error: 'error',
  stale_review: 'stale review',
}

const EVENT_COLOR: Record<PublishEvent['type'], string> = {
  submitted: '#9a6700',
  approved: '#1a7f37',
  rejected: '#cf222e',
  withdrawn: '#6e7781',
  blocked: '#6e7781',
  error: '#cf222e',
  stale_review: '#9a6700',
}

function eventPayload(event: PublishEvent): Record<string, unknown> {
  return JSON.parse(event.payloadJson) as Record<string, unknown>
}

function eventVersion(event: PublishEvent): string | null {
  const payload = eventPayload(event)
  const version = payload.version ?? payload.desiredVersion
  return typeof version === 'string' ? version : null
}

function eventDetail(event: PublishEvent): string | null {
  const payload = eventPayload(event)
  switch (event.type) {
    case 'rejected':
      return typeof payload.reason === 'string' ? payload.reason : null
    case 'error':
      return typeof payload.message === 'string' ? payload.message : null
    case 'submitted':
      return typeof payload.detail === 'string' ? payload.detail : null
    case 'stale_review':
      return `${payload.status} for ${payload.ageDays}+ days`
    case 'blocked':
      return typeof payload.inReviewVersion === 'string' ? `waiting behind v${payload.inReviewVersion}` : null
    case 'approved':
    case 'withdrawn':
      return null
  }
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
  const matchingCredentials = credentials.filter((c) => c.store === store)

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api(`/v1/extensions/${extensionId}/targets`, {
        method: 'POST',
        body: JSON.stringify({ store, credentialId, storeItemId }),
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
        <tbody>
          {targets.map((t) => (
            <tr key={t.id} style={{ borderBottom: '1px solid #eee' }}>
              <td>{t.store}</td>
              <td>
                <code>{t.storeItemId}</code>
              </td>
              <td>
                {t.credentialLabel}{' '}
                {t.credentialStatus !== 'active' && <span style={{ color: 'crimson' }}>({t.credentialStatus})</span>}
              </td>
              <td>{t.enabled ? 'enabled' : 'disabled'}</td>
              <td>
                <button onClick={() => void toggle(t)}>{t.enabled ? 'Disable' : 'Enable'}</button>{' '}
                <button onClick={() => void remove(t)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {targets.length === 0 && <p>No stores configured yet.</p>}

      {availableStores.length > 0 && (
        <>
          <h4>Add a store</h4>
          <form onSubmit={add} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={store}
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
            <select value={credentialId} onChange={(e) => setCredentialId(e.target.value)} required>
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
              No {store} credential yet — add one in Settings → Store credentials first.
            </p>
          )}
        </>
      )}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </section>
  )
}

function EventsSection({ extensionId }: { extensionId: string }) {
  const [events, setEvents] = useState<PublishEvent[]>([])

  useEffect(() => {
    void api<{ events: PublishEvent[] }>(`/v1/extensions/${extensionId}/events`).then((r) => setEvents(r.events))
  }, [extensionId])

  return (
    <section>
      <h3>Timeline</h3>
      {events.length === 0 && <p>No events yet.</p>}
      {events.length > 0 && (
        <table cellPadding={6} style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
              <th>Time</th>
              <th>Store</th>
              <th>Version</th>
              <th>Event</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const detail = eventDetail(e)
              return (
                <tr key={e.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ color: '#666', fontSize: 12, whiteSpace: 'nowrap' }}>{relativeTime(e.createdAt)}</td>
                  <td>{e.store}</td>
                  <td>{eventVersion(e) ? <code>{eventVersion(e)}</code> : '—'}</td>
                  <td>
                    <span style={{ color: EVENT_COLOR[e.type], fontWeight: 600 }}>{EVENT_LABEL[e.type]}</span>
                    {detail && <div style={{ fontSize: 12, color: '#666' }}>{detail}</div>}
                  </td>
                </tr>
              )
            })}
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
          <EventsSection extensionId={extensionId} />
        </div>
      ) : (
        <p style={{ color: STATUS_COLOR.blocked }}>
          Licensing is coming in Phase 2. Interested? Let us know and we'll notify you when it ships.
        </p>
      )}
    </section>
  )
}
