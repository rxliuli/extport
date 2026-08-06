# Safari app customization (design)

Status: setup-instructions page **prototyped on twitter-blocker**
(2026-08-06), macOS and iOS verified in simulator; not yet integrated into
extport's build pipeline. Notifications polyfill **abandoned** — see §2.

## Problem

`xcrun safari-web-extension-converter` generates a host app with a near-empty
UI — just an icon and "You can turn on X's extension in Safari Extensions
preferences." Users don't know how to enable or use the extension, especially
on iOS where the flow is non-obvious (Settings → Apps → Safari → Extensions).

## Two features

### 1. Setup instructions page (prototyped)

Replace the generated `Main.html` / `Style.css` / `Script.js` with a
template that shows step-by-step enabling instructions, platform-aware:

**macOS:**
- Extension status badge (enabled/disabled, via existing `SFSafariExtensionManager` detection)
- Four-step guide: Open Safari → Settings → Extensions → check the box → allow permissions
- "Open Safari Settings…" button (existing `SFSafariApplication.showPreferencesForExtension`)

**iOS:**
- Four-step guide: Open Settings → Apps → Safari → Extensions → toggle on → set permissions to Allow
- Usage hint at the bottom (e.g., how to find the extension in Safari)
- No status detection or deep-link button (no public API on iOS)

**Integration plan:**
- In `convertToXcodeProject` post-processing (alongside `updateProjectConfig`
  and `updateInfoPlist`), replace the three resource files with templated
  versions — extension name substituted from `projectName`.
- Increase macOS storyboard window height from 325 to 480 (sed on the XML).
- The `Shared (App)/ViewController.swift` and storyboard files stay as
  generated — they already handle platform detection and pass it to the
  web view via `show('mac', enabled, useSettings)` / `show('ios')`.

**Config surface:**
- `safari.setupHint` (optional string) — shown at the bottom of the iOS
  instructions. If omitted, no hint is displayed. Keeps config minimal;
  enabling steps are 100% standard across all extensions.

**Xcode project structure difference:**
- `--macos-only`: flat layout (`ProjectName/`, `ProjectName Extension/`)
- default (both): grouped layout (`Shared (App)/`, `macOS (App)/`, `iOS (App)/`, `Shared (Extension)/`, etc.)
- Template files go into `Resources/` which is under the app directory
  (flat) or `Shared (App)/` (grouped) — need to handle both paths.

### 2. Notifications API polyfill — ABANDONED (2026-08-06)

Prototyped end-to-end on twitter-blocker, then dropped. `create()` worked;
the click behaviour is what killed it. Recording the findings so nobody
walks this path again.

**What worked.** `browser.notifications.create()` / `.clear()` bridged fine:
polyfill in `public/` (so wxt copies it to the output) prepended to
`background.scripts` via the `build:manifestGenerated` hook →
`sendNativeMessage` → `SafariWebExtensionHandler` →
`UNUserNotificationCenter`. Requires swapping the `notifications` permission
for `nativeMessaging` in the Safari manifest. On macOS 13+ the permission
prompt arrives *as a notification* with an Options dropdown, not a dialog —
easy to miss when testing.

**Why it was abandoned: clicking a notification opens the host app.** That
is unconditional macOS behaviour — `UNNotificationContent` has no "do
nothing on click" option. So the user clicks a "42 accounts blocked"
notification and gets a window explaining how to install the extension.
That is worse than having no notification at all, and it cannot be
suppressed:

- **The appex can't receive the click.** It is a short-lived process; it has
  long exited by the time the notification is clicked.
- **The host app's delegate can't either.** `UNUserNotificationCenterDelegate`
  only sees notifications posted by its *own* process, and the notification's
  owner is the appex. Verified: `didReceive` never fires.
- **"Was I launched by a click?" is unanswerable.** Probed by checking
  `getDeliveredNotifications()` in `applicationDidBecomeActive` — the system
  removes the notification *before* launching the app, so the list is always
  empty. Log showed `became active, no delivered notifications` on every
  click.
- **`SFSafariApplication.dispatchMessage` does not apply.** It targets the
  legacy Safari *App* Extension, not Web Extensions — `browser.runtime.onMessage`
  never receives it. Xcode 16+ also makes calling it from an extension
  process a compile error. And it doesn't exist on iOS at all.

**The broader asymmetry** (worth knowing independently of notifications):

| Direction | Available |
|---|---|
| extension → native | `sendNativeMessage`, `connectNative` |
| native → extension (macOS) | nothing; polling is the only option |
| native → extension (iOS) | nothing; no `SFSafariApplication` either |

Apple's own forum thread asking whether polling is the only option has sat
unanswered: https://developer.apple.com/forums/thread/694479

**What to do instead.** `browser.action.setBadgeText()` works on Safari with
no native bridging (verified in gmail-notifier). It's a passive indicator
rather than an active alert, but for "task finished" it covers the need
without the native machinery.

**Only reconsider if** the click behaviour becomes suppressible, or the
extension genuinely needs fire-and-forget alerts *and* can accept the host
app opening on click. Making `onClicked` work would need the notification to
be posted by the app (not the appex), which means an App Group, the appex
waking the app, and the extension polling — an entitlement/signing burden on
extport's automated pipeline, still broken on iOS.

## Prototype files

Tested on: `twitter-exporter/packages/twitter-blocker/.output/Blocker for Twitter/`

Modified files (in `.output`, not committed — regenerated by converter):
- `Shared (App)/Resources/Base.lproj/Main.html`
- `Shared (App)/Resources/Style.css`
- `Shared (App)/Resources/Script.js`
- `macOS (App)/Base.lproj/Main.storyboard` (window height 325→480)

The twitter-blocker working tree was reverted after the experiment; nothing
from it remains committed.

## Notes for whoever integrates this

- `pnpm build:safari` (`wxt zip -b safari`) rebuilds the output *and* runs
  the converter, so anything hand-edited under `.output/` is destroyed on
  every build. Files the extension itself needs go in `public/`; everything
  in the generated Xcode project has to be re-applied by a post-processing
  step. A throwaway `scripts/patch-xcode.mjs` did this during the prototype
  and is the shape the `@extport/wxt` step should take.
- **Don't debug the host app with `NSLog`.** Whether it reaches the unified
  log from a GUI launch is inconsistent, which made several probes here
  ambiguous and cost real time. Append to a file instead — and note the app
  is sandboxed, so `/tmp` is not writable; use `NSTemporaryDirectory()` and
  read from `~/Library/Containers/<bundle-id>/Data/tmp/`.
- Safari refuses to enable an extension while UI automation is running
  ("Safari detected an app or service that interfered with clicking"), which
  looks like an extension bug but isn't.
