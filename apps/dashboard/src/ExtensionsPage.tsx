import { useEffect, useState } from 'react'
import { api, ApiError, type Extension } from './api'

export function ExtensionsPage() {
  const [extensions, setExtensions] = useState<Extension[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Extension | null>(null)

  const reload = () =>
    api<{ extensions: Extension[] }>('/v1/extensions').then((r) => setExtensions(r.extensions))

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
      <table cellPadding={6} style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
            <th>Name</th>
            <th>Slug</th>
            <th>Publishing</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {extensions.map((ext) => (
            <tr key={ext.id} style={{ borderBottom: '1px solid #eee' }}>
              <td>{ext.name}</td>
              <td>
                <code>{ext.slug}</code>
              </td>
              <td>{ext.publishingEnabled ? 'on' : 'off'}</td>
              <td>
                <button onClick={() => setSelected(selected?.id === ext.id ? null : ext)}>
                  {selected?.id === ext.id ? 'Hide' : 'CI setup'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {extensions.length === 0 && <p>No extensions yet — add your first one above.</p>}
      {selected && (
        <div style={{ background: '#f6f6f6', padding: 12, marginTop: 12, borderRadius: 6 }}>
          <p style={{ marginTop: 0 }}>
            Upload artifacts for <strong>{selected.name}</strong> from CI:
          </p>
          <pre style={{ overflowX: 'auto' }}>
            {`npx extport push dist.zip --extension ${selected.slug} --version 1.2.3\n`}
            {`# EXTPORT_API_KEY must be set (Settings → API keys)`}
          </pre>
        </div>
      )}
    </section>
  )
}
