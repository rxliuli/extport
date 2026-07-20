import { useEffect, useState } from 'react'
import { api, ApiError, type MatrixExtension, type Store } from './api'
import { ageDays, STATUS_COLOR, STATUS_LABEL } from './status'

const STORES: Store[] = ['chrome', 'firefox', 'edge', 'apple']
const STORE_LABEL: Record<Store, string> = { chrome: 'Chrome', firefox: 'Firefox', edge: 'Edge', apple: 'Apple' }

function Cell({ target }: { target: MatrixExtension['targets'][number] | undefined }) {
  if (!target) {
    return <span style={{ color: '#aaa' }}>—</span>
  }
  const days = ageDays(target.submittedAt)
  const suffix = target.status === 'in_review' && days !== null ? ` (${days}d)` : ''
  return (
    <span style={{ color: STATUS_COLOR[target.status], fontWeight: 600 }} title={target.statusDetail ?? undefined}>
      {target.liveVersion ?? '—'} · {STATUS_LABEL[target.status]}
      {suffix}
    </span>
  )
}

export function ExtensionsPage({ onSelect }: { onSelect: (id: string) => void }) {
  const [extensions, setExtensions] = useState<MatrixExtension[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reload = () =>
    api<{ extensions: MatrixExtension[] }>('/v1/extensions/matrix').then((r) => setExtensions(r.extensions))

  useEffect(() => {
    void reload()
  }, [])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api('/v1/extensions', { method: 'POST', body: JSON.stringify({ name }) })
      setName('')
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <section>
      <h2>Extensions</h2>
      <form onSubmit={create} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Extension name"
          required
        />
        <button type="submit">Add</button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <table cellPadding={8} style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
            <th>Extension</th>
            {STORES.map((s) => (
              <th key={s}>{STORE_LABEL[s]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {extensions.map((ext) => (
            <tr key={ext.id} style={{ borderBottom: '1px solid #eee' }}>
              <td>
                <button
                  onClick={() => onSelect(ext.id)}
                  style={{ background: 'none', border: 'none', padding: 0, color: '#0969da', cursor: 'pointer', font: 'inherit' }}
                >
                  {ext.name}
                </button>
                <div style={{ fontSize: 12, color: '#666' }}>{ext.slug}</div>
              </td>
              {STORES.map((s) => (
                <td key={s}>
                  <Cell target={ext.targets.find((t) => t.store === s)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {extensions.length === 0 && <p>No extensions yet — add your first one above.</p>}
    </section>
  )
}
