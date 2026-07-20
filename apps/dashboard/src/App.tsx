import { useEffect, useState } from 'react'

interface Me {
  authType: 'session' | 'api_key'
  tenant: { id: string; name: string; plan: string }
  user: { id: string; email: string; displayName: string | null } | null
}

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/v1/me', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setMe(data))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <main style={{ fontFamily: 'system-ui', padding: 32 }}>Loading…</main>

  return (
    <main style={{ fontFamily: 'system-ui', padding: 32, maxWidth: 640 }}>
      <h1>extport</h1>
      <p>Browser extension publishing &amp; licensing platform.</p>
      {me ? (
        <>
          <p>
            Signed in as <strong>{me.user?.displayName ?? me.user?.email}</strong> · tenant{' '}
            <code>{me.tenant.name}</code> ({me.tenant.plan})
          </p>
          <button
            onClick={() => {
              void fetch('/auth/logout', { method: 'POST', credentials: 'include' }).then(() =>
                setMe(null),
              )
            }}
          >
            Sign out
          </button>
        </>
      ) : (
        <a href="/auth/github">Sign in with GitHub</a>
      )}
    </main>
  )
}
