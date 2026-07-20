import { useEffect, useState } from 'react'
import { ExtensionDetailPage } from './ExtensionDetailPage'
import { ExtensionsPage } from './ExtensionsPage'
import { SettingsPage } from './SettingsPage'
import type { Me } from './api'

type Page = 'extensions' | 'settings'

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState<Page>('extensions')
  const [selectedExtensionId, setSelectedExtensionId] = useState<string | null>(null)

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

  const goToPage = (next: Page) => {
    setSelectedExtensionId(null)
    setPage(next)
  }

  return (
    <main style={{ fontFamily: 'system-ui', padding: 32, maxWidth: 840 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>extport</h1>
        <nav style={{ display: 'flex', gap: 12 }}>
          <button onClick={() => goToPage('extensions')} disabled={page === 'extensions' && !selectedExtensionId}>
            Extensions
          </button>
          <button onClick={() => goToPage('settings')} disabled={page === 'settings'}>
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
      {page === 'extensions' && selectedExtensionId ? (
        <ExtensionDetailPage extensionId={selectedExtensionId} onBack={() => setSelectedExtensionId(null)} />
      ) : page === 'extensions' ? (
        <ExtensionsPage onSelect={setSelectedExtensionId} />
      ) : (
        <SettingsPage />
      )}
    </main>
  )
}
