# Safari app customization (design)

Status: setup-instructions page **shipped** in @extport/wxt 0.0.9
(`src/safari-setup-page.ts`), applied automatically on every Safari
conversion with no configuration. Notifications polyfill **abandoned** —
see §2.

## Problem

`xcrun safari-web-extension-converter` generates a host app with a near-empty
UI — just an icon and "You can turn on X's extension in Safari Extensions
preferences." Users don't know how to enable or use the extension, especially
on iOS where the flow is non-obvious (Settings → Apps → Safari → Extensions).

## Two features

### 1. Setup instructions page — SHIPPED

`src/safari-setup-page.ts`, called from `convertToXcodeProject` after
`updateProjectConfig`/`updateInfoPlist`. Replaces the generated
`Main.html` / `Style.css` / `Script.js` with a platform-aware setup guide
and widens the macOS window (325 → 480) so it isn't clipped.

**macOS:** status badge (via the generated `SFSafariExtensionManager`
detection), four-step guide, and the "Open Safari Settings…" button —
still the converter's own `showPreferencesForExtension` call.

**iOS:** four-step guide through Settings → Apps → Safari → Extensions,
plus a closing hint about the extensions button in the address bar. No
status badge or deep link — neither has a public API on iOS (§2 covers
why that gap is structural).

**Zero configuration.** The extension's name is the only variable and it
comes from the same manifest the converter named the project after. An
earlier draft had a `safari.setupHint` field for per-extension usage
text; it was dropped because how-to-use is genuinely divergent (passive
effect vs popup vs options page) and a single line couldn't serve it.
A project that wants something else overwrites these three files from its
own `build:done` hook — that escape hatch exists without extport adding a
knob for it.

**Two things worth knowing before touching this:**

- **Two layouts.** A single-platform conversion lays sources out flat
  under the project name; a macOS+iOS one groups them under `Shared
  (App)`/`macOS (App)`. `resolveAppPaths` probes for the directory rather
  than inferring it from `projectType`, so it stays right if the
  converter's choice changes.
- **Two `show()` signatures.** The generated `ViewController` calls
  `show(platform, enabled, useSettings)` in a grouped project but
  `show(enabled, useSettings)` in a flat one. The script sniffs its first
  argument instead of requiring a matching ViewController, so one file
  works with either — and the generated Swift is left untouched.

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

## Verification

Both features were prototyped against
`twitter-exporter/packages/twitter-blocker` (macOS+iOS, and it uses the
notifications API), with the setup page also checked on the iOS simulator.
That working tree was reverted afterwards; nothing from the experiments
remains committed there.

The shipped §1 path was then re-verified end to end: `pnpm build:safari`
with the local build → the generated project carries the new page and a
480pt window → `xcodebuild` → the running app shows icon, title, status
badge, four steps and the button, with no hand-patching anywhere.

## Notes if you work on this again

- **Read a pbxproj with `plutil`, never with regexes.** It's an OpenStep
  property list, so `plutil -convert json -o - <path>` parses it natively —
  Apple's own parser, no dependency, and it moves with the format. Writing
  is a different matter: plutil can't emit OpenStep back, and a full rewrite
  would drop the `/* … */` comments and turn every build into an
  unreviewable diff. So `safari-xcode.ts` reads structure via plutil and
  rewrites by pinpoint substitution on ids plutil handed it. Inferring
  structure with regexes is what produced the bundle-id bug below.
- **Bundle ids can't be told apart by their strings.** The converter does
  not reliably honour `--bundle-identifier`: it renames targets after the
  *project*, and which ones it mangles varies by Xcode version and by the
  `--ios-only`/`--macos-only` flag. On gmail-notifier (2026-08-07,
  macos-only, display name diverged from the bundle id) it renamed the *app*
  and gave the extension the raw identifier with no suffix — the exact
  inverse of the old "shortest id is the app's stem" heuristic, which then
  saw `stem === bundleIdentifier`, concluded "already correct", and changed
  nothing. Xcode refused the build. Target identity now comes from
  `productType`, and the `.Extension` suffix is derived rather than
  preserved.
- **A bug-era build pollutes the machine's extension registry.** Archives
  made before that fix registered the extension under the unsuffixed id;
  those entries survive in `pluginkit` even after the DerivedData folder is
  gone, and they shadow the correct id — which shows up as the status badge
  never resolving and "Open Safari Settings…" silently quitting the app
  (the generated handler calls `terminate` without checking the error).
  Inspect with `pluginkit -m -p com.apple.Safari.web-extension -vvv` and
  clear with `pluginkit -r <path-to.appex>`. Local dev only; shipped builds
  are unaffected.
- `pnpm build:safari` (`wxt zip -b safari`) rebuilds the output *and* runs
  the converter, so anything hand-edited under `.output/` is destroyed on
  every build. Files the extension itself needs go in `public/`; everything
  in the generated Xcode project has to be re-applied by a post-processing
  step — which is what `safari-setup-page.ts` now does.
- **The generated ViewController isn't guaranteed to call `show()`.** A
  single-platform project's only calls it if the extension-state lookup
  succeeds, while a macOS+iOS one calls `show('mac')` unconditionally first.
  The setup page therefore seeds the platform itself from the user agent —
  without that, a failed lookup left the window showing nothing but an icon.
  For the same reason the status badge is absent until a state is actually
  known: a "checking…" placeholder would sit there forever and read as a hang.
- **Don't debug the host app with `NSLog`.** Whether it reaches the unified
  log from a GUI launch is inconsistent, which made several probes here
  ambiguous and cost real time. Append to a file instead — and note the app
  is sandboxed, so `/tmp` is not writable; use `NSTemporaryDirectory()` and
  read from `~/Library/Containers/<bundle-id>/Data/tmp/`.
- Safari refuses to enable an extension while UI automation is running
  ("Safari detected an app or service that interfered with clicking"), which
  looks like an extension bug but isn't.
