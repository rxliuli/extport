import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

/**
 * Chrome for the buyer-facing pages (portal.extport.dev): a slim brand
 * bar with a way back to the portal home, and a full-height background so
 * the page never shows a seam below short content.
 */
export function PortalShell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-6">
          <Link to="/portal" className="text-lg font-bold tracking-tight">
            extport
          </Link>
          <div className="flex items-center gap-3">{actions}</div>
        </div>
      </header>
      {children}
    </div>
  )
}
