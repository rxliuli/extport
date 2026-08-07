import type { ReactNode } from 'react'

/**
 * Chrome for the buyer-facing pages (portal.extport.dev): a slim brand
 * bar and a full-height background so the page never shows a seam below
 * short content.
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
          <a href="https://extport.dev" target="_blank" rel="noreferrer" className="text-lg font-bold tracking-tight">
            extport
          </a>
          <div className="flex items-center gap-3">{actions}</div>
        </div>
      </header>
      {children}
    </div>
  )
}
