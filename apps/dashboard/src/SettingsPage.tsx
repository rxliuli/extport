import { useEffect, useState } from 'react'
import { api, ApiError, type ApiKeyRow, type CredentialRow } from './api'

const CREDENTIAL_FIELDS: Record<CredentialRow['store'], { key: string; label: string; textarea?: boolean }[]> = {
  chrome: [
    { key: 'publisherId', label: 'Publisher ID (Developer Dashboard → Account)' },
    { key: 'clientEmail', label: 'Service Account Email' },
    { key: 'privateKey', label: 'Service Account Private Key (.json → private_key)', textarea: true },
  ],
  firefox: [
    { key: 'jwtIssuer', label: 'JWT Issuer' },
    { key: 'jwtSecret', label: 'JWT Secret' },
  ],
  edge: [
    { key: 'clientId', label: 'Client ID' },
    { key: 'apiKey', label: 'API Key' },
  ],
  safari: [
    { key: 'keyId', label: 'Key ID' },
    { key: 'issuerId', label: 'Issuer ID' },
    { key: 'privateKeyP8', label: '.p8 Private Key', textarea: true },
  ],
}

const STATUS_COLOR: Record<CredentialRow['status'], string> = {
  active: 'green',
  expiring: 'darkorange',
  invalid: 'crimson',
}

function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([])
  const [name, setName] = useState('')
  const [freshKey, setFreshKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = () => api<{ keys: ApiKeyRow[] }>('/v1/keys').then((r) => setKeys(r.keys))
  useEffect(() => {
    void reload()
  }, [])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const created = await api<{ key: string }>('/v1/keys', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      setFreshKey(created.key)
      setName('')
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const revoke = async (id: string) => {
    await api(`/v1/keys/${id}`, { method: 'DELETE' })
    await reload()
  }

  return (
    <section>
      <h3>API keys</h3>
      <form onSubmit={create} style={{ display: 'flex', gap: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name (e.g. ci)" required />
        <button type="submit">Create</button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {freshKey && (
        <p style={{ background: '#fff8dc', padding: 8, borderRadius: 4 }}>
          Copy now — shown once: <code>{freshKey}</code>{' '}
          <button onClick={() => setFreshKey(null)}>Dismiss</button>
        </p>
      )}
      <ul>
        {keys.map((k) => (
          <li key={k.id}>
            <code>{k.masked}</code> {k.name}{' '}
            <button onClick={() => void revoke(k.id)}>Revoke</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function CredentialsSection() {
  const [rows, setRows] = useState<CredentialRow[]>([])
  const [store, setStore] = useState<CredentialRow['store']>('chrome')
  const [label, setLabel] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = () =>
    api<{ credentials: CredentialRow[] }>('/v1/credentials').then((r) => setRows(r.credentials))
  useEffect(() => {
    void reload()
  }, [])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api('/v1/credentials', {
        method: 'POST',
        body: JSON.stringify({
          store,
          label: label || undefined,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
          credentials: fields,
        }),
      })
      setFields({})
      setLabel('')
      setExpiresAt('')
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const verify = async (id: string) => {
    await api(`/v1/credentials/${id}/verify`, { method: 'POST' }).catch(() => {})
    await reload()
  }

  const remove = async (id: string) => {
    setError(null)
    try {
      await api(`/v1/credentials/${id}`, { method: 'DELETE' })
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <section>
      <h3>Store credentials</h3>
      <table cellPadding={6} style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={{ borderBottom: '1px solid #eee' }}>
              <td>{row.store}</td>
              <td>{row.label}</td>
              <td>
                <code>…{row.hint}</code>
              </td>
              <td style={{ color: STATUS_COLOR[row.status], fontWeight: 600 }}>{row.status}</td>
              <td>
                <button onClick={() => void verify(row.id)}>Verify</button>{' '}
                <button onClick={() => void remove(row.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Add credential</h4>
      <form onSubmit={add} style={{ display: 'grid', gap: 8, maxWidth: 480 }}>
        <select
          value={store}
          onChange={(e) => {
            setStore(e.target.value as CredentialRow['store'])
            setFields({})
          }}
        >
          <option value="chrome">Chrome Web Store</option>
          <option value="firefox">Firefox AMO</option>
          <option value="edge">Edge Partner Center</option>
          <option value="safari">App Store Connect</option>
        </select>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" />
        {CREDENTIAL_FIELDS[store].map((f) =>
          f.textarea ? (
            <textarea
              key={f.key}
              rows={5}
              placeholder={f.label}
              value={fields[f.key] ?? ''}
              onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
              required
            />
          ) : (
            <input
              key={f.key}
              placeholder={f.label}
              value={fields[f.key] ?? ''}
              onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
              required
            />
          ),
        )}
        {store === 'edge' && (
          <label>
            API key expiry:{' '}
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Verifying…' : 'Verify & save'}
        </button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </section>
  )
}

export function SettingsPage() {
  return (
    <>
      <h2>Settings</h2>
      <ApiKeysSection />
      <hr />
      <CredentialsSection />
    </>
  )
}
