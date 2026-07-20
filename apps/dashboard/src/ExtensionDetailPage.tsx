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

function eventSummary(event: PublishEvent): string {
  const payload = JSON.parse(event.payloadJson) as Record<string, unknown>
  switch (event.type) {
    case 'submitted':
      return `submitted v${payload.version}`
    case 'approved':
      return `v${payload.version} went live`
    case 'rejected':
      return `v${payload.version ?? '?'} rejected${payload.reason ? `: ${payload.reason}` : ''}`
    case 'withdrawn':
      return `withdrew v${payload.version}`
    case 'error':
      return String(payload.message ?? 'error')
    case 'stale_review':
      return `still ${payload.status} after ${payload.ageDays}+ days`
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
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {events.map((e) => (
          <li key={e.id} style={{ padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
            <span style={{ color: '#666', fontSize: 12 }}>{relativeTime(e.createdAt)}</span> ·{' '}
            <strong>{e.store}</strong> · {eventSummary(e)}
          </li>
        ))}
      </ul>
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
