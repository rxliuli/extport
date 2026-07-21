import { CircleCheck, CircleDashed, CircleX, Clock, SkipForward, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  api,
  ApiError,
  type CredentialRow,
  type DeploymentVersion,
  type Extension,
  type PublishTarget,
  type Store,
} from './api'
import { ageDays, STATUS_COLOR } from './status'
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
  const [crxId, setCrxId] = useState('')
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
        body: JSON.stringify({
          store: selectedStore,
          credentialId: selectedCredentialId,
          storeItemId,
          ...(selectedStore === 'edge' && crxId ? { crxId } : {}),
        }),
      })
      setStoreItemId('')
      setCrxId('')
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
                  {t.crxId && (
                    <>
                      <br />
                      <span style={{ fontSize: 12, color: '#666' }}>
                        crx: <code>{t.crxId}</code>
                      </span>
                    </>
                  )}
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
              placeholder={selectedStore === 'edge' ? 'Product ID (Partner Center → Extension identity)' : 'Store item id'}
              required
            />
            {selectedStore === 'edge' && (
              <input
                value={crxId}
                onChange={(e) => setCrxId(e.target.value)}
                placeholder="CRX ID (optional — public status lookups)"
              />
            )}
            <button type="submit" disabled={matchingCredentials.length === 0}>
              Add
            </button>
          </form>
          {selectedStore === 'edge' && (
            <p style={{ fontSize: 13, color: '#666' }}>
              Partner Center's submission API and its public status page use two different ids for the same
              listing — Product ID is required for publishing; CRX ID is optional and only improves live-version
              detection between reconciles.
            </p>
          )}
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

// Cell vocabulary for the version × store matrix. Shape carries the meaning,
// color only reinforces it (color alone is invisible to color-blind readers).
const CELL: Record<DeploymentVersion['status'], { Icon: LucideIcon; color: string; label: string }> = {
  online: { Icon: CircleCheck, color: '#1a7f37', label: 'live' },
  in_review: { Icon: Clock, color: '#9a6700', label: 'in review' },
  queued: { Icon: CircleDashed, color: '#9a6700', label: 'queued' },
  skipped: { Icon: SkipForward, color: '#6e7781', label: 'skipped' },
  rejected: { Icon: CircleX, color: '#cf222e', label: 'rejected' },
}

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

function cellTitle(row: DeploymentVersion, isCurrentLive: boolean): string {
  const days = ageDays(row.submittedAt)
  const parts: string[] = []
  if (row.status === 'online') parts.push(isCurrentLive ? 'live now' : 'was live')
  else if (row.status === 'in_review' && days !== null) parts.push(`in review for ${days}d`)
  else parts.push(CELL[row.status].label)
  if (row.statusDetail) parts.push(row.statusDetail)
  parts.push(`updated ${relativeTime(row.updatedAt)}`)
  return parts.join(' · ')
}

// deployment_versions pivoted into rows = versions, columns = stores — the
// release-progress view. One glance along a row answers "where is 0.0.7
// live?"; down a column, a store's full history. Target-level health
// (error/stale_review) has no version, so it deliberately doesn't appear
// here — that lives on the Store targets table above.
function VersionMatrixSection({ extensionId }: { extensionId: string }) {
  const [versions, setVersions] = useState<DeploymentVersion[]>([])

  useEffect(() => {
    void api<{ versions: DeploymentVersion[] }>(`/v1/extensions/${extensionId}/timeline`).then((r) => setVersions(r.versions))
  }, [extensionId])

  const stores = STORES.filter((s) => versions.some((v) => v.store === s))
  const versionNumbers = [...new Set(versions.map((v) => v.version))].sort((a, b) => compareVersions(b, a))

  // The endpoint returns newest-first; keep the first (freshest) row per cell.
  const byCell = new Map<string, DeploymentVersion>()
  for (const v of versions) {
    const key = `${v.store}:${v.version}`
    if (!byCell.has(key)) byCell.set(key, v)
  }

  // Per column, only the MAX online version is live right now; older online
  // rows are history ("was live") and render faded so it can't read as
  // several versions being live at once.
  const currentLive = new Map<Store, string>()
  for (const store of stores) {
    const online = versions.filter((v) => v.store === store && v.status === 'online').map((v) => v.version)
    if (online.length > 0) currentLive.set(store, online.sort(compareVersions).at(-1)!)
  }

  return (
    <section>
      <h3>Versions</h3>
      {versionNumbers.length === 0 && <p>No versions tracked yet.</p>}
      {versionNumbers.length > 0 && (
        <>
          <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #ccc' }}>
                <th style={{ textAlign: 'left' }}>Version</th>
                {stores.map((s) => (
                  <th key={s} style={{ textAlign: 'center', padding: '4px 14px' }}>
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {versionNumbers.map((version) => (
                <tr key={version} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td>
                    <code>{version}</code>
                  </td>
                  {stores.map((store) => {
                    const row = byCell.get(`${store}:${version}`)
                    if (!row) return <td key={store} />
                    const isCurrentLive = row.status === 'online' && currentLive.get(store) === version
                    const wasLive = row.status === 'online' && !isCurrentLive
                    const days = row.status === 'in_review' ? ageDays(row.submittedAt) : null
                    const { Icon, color, label } = CELL[row.status]
                    return (
                      <td key={store} title={cellTitle(row, isCurrentLive)} style={{ textAlign: 'center', cursor: 'default' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color, opacity: wasLive ? 0.35 : 1 }}>
                          <Icon size={16} strokeWidth={2.25} aria-label={label} />
                          {days !== null && <span style={{ fontSize: 11 }}>{days}d</span>}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 12, color: '#666', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {(Object.keys(CELL) as DeploymentVersion['status'][]).map((status) => {
              const { Icon, color, label } = CELL[status]
              return (
                <span key={status} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon size={13} strokeWidth={2.25} color={color} /> {label}
                </span>
              )
            })}
            <span>— hover a cell for details</span>
          </p>
        </>
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
          <VersionMatrixSection extensionId={extensionId} />
        </div>
      ) : (
        <p style={{ color: STATUS_COLOR.blocked }}>
          Licensing is coming in Phase 2. Interested? Let us know and we'll notify you when it ships.
        </p>
      )}
    </section>
  )
}
