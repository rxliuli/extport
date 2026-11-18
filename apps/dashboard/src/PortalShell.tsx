import type { ReactNode } from 'react'

const SITE_URL = 'https://extport.dev'

/**
 * Chrome for the buyer-facing pages (portal.extport.dev): a slim brand
 * bar, a quiet footer, and a full-height background so the page never
 * shows a seam below short content.
 */
export function PortalShell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-6">
          {/* The portal is a single page, so this has nowhere useful to
              link back to — points at the marketing site instead, opened
              in a new tab so a curious buyer doesn't lose their signed-in
              portal view. */}
          <a href={SITE_URL} target="_blank" rel="noreferrer" className="text-lg font-bold tracking-tight">
            extport
          </a>
          <div className="flex items-center gap-3">{actions}</div>
        </div>
      </header>
      {children}
      {/* The buyer bought from the extension's developer; extport only
          runs the licensing — said once, quietly, with the policies that
          cover what extport itself processes. Help lives per purchase. */}
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-6 py-4 text-xs text-muted-foreground">
          <span>
            Licenses managed by{' '}
            <a href={SITE_URL} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
              extport
            </a>
          </span>
          <nav className="flex items-center gap-4">
            <a href={`${SITE_URL}/privacy`} target="_blank" rel="noreferrer" className="hover:text-foreground">
              Privacy
            </a>
            <a href={`${SITE_URL}/terms`} target="_blank" rel="noreferrer" className="hover:text-foreground">
              Terms
            </a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
