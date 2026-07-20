import { useEffect, useState } from 'react'
import { ExtensionsPage } from './ExtensionsPage'
import { SettingsPage } from './SettingsPage'
import type { Me } from './api'

type Page = 'extensions' | 'settings'

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState<Page>('extensions')

  useEffect(() => {
    fetch('/v1/me', { credentials: 'include' })
      .then((res) => (res.ok ? (res.json() as Promise<Me>) : null))
      .then((data) => setMe(data))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <main style={{ fontFamily: 'system-ui', padding: 32 }}>Loading…</main>

  if (!me) {
    return (
      <main style={{ fontFamily: 'system-ui', padding: 32, maxWidth: 720 }}>
        <h1>extport</h1>
        <p>Browser extension publishing &amp; licensing platform.</p>
        <a href="/auth/github">Sign in with GitHub</a>
      </main>
    )
  }

  return (
    <main style={{ fontFamily: 'system-ui', padding: 32, maxWidth: 720 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>extport</h1>
        <nav style={{ display: 'flex', gap: 12 }}>
          <button onClick={() => setPage('extensions')} disabled={page === 'extensions'}>
            Extensions
          </button>
          <button onClick={() => setPage('settings')} disabled={page === 'settings'}>
            Settings
          </button>
        </nav>
        <span style={{ marginLeft: 'auto', fontSize: 14, color: '#666' }}>
          {me.user?.displayName ?? me.user?.email} · {me.tenant.plan}{' '}
          <button
            onClick={() => {
              void fetch('/auth/logout', { method: 'POST', credentials: 'include' }).then(() =>
                setMe(null),
              )
            }}
          >
            Sign out
          </button>
        </span>
      </header>
      {page === 'extensions' ? <ExtensionsPage /> : <SettingsPage />}
    </main>
  )
}
