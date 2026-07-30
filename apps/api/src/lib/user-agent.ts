// Ping dimension derivation — the client sends almost nothing; browser and
// OS come from the User-Agent of the background fetch itself. Order matters:
// Edge UAs contain "Chrome" and "Safari", Chrome UAs contain "Safari",
// Android UAs contain "Linux".

export type PingBrowser = 'chrome' | 'firefox' | 'edge' | 'safari' | 'other'

export function parseBrowser(ua: string | undefined): PingBrowser {
  if (!ua) return 'other'
  if (/Firefox\//i.test(ua)) return 'firefox'
  if (/Edg(?:e|A|iOS)?\//i.test(ua)) return 'edge'
  if (/(?:Chrome|Chromium|CriOS)\//i.test(ua)) return 'chrome'
  if (/Safari\//i.test(ua)) return 'safari'
  return 'other'
}

export function parseOs(ua: string | undefined): string | null {
  if (!ua) return null
  if (/Windows/i.test(ua)) return 'windows'
  if (/Android/i.test(ua)) return 'android'
  if (/CrOS/i.test(ua)) return 'chromeos'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return null
}
