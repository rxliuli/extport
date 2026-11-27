---
title: Port Chrome extensions to Safari
description: Convert any Manifest V3 Chrome extension into a signed Safari app and install it directly onto your own Mac or iPhone — no extport account or Xcode setup required.
---

Have a Chrome extension you want to use in Safari on your own Mac or iPhone? `extport port safari` downloads the extension straight from the Chrome Web Store (or reads a local `.crx`, `.zip`, or folder), converts it to a Safari Web Extension, signs it with a certificate already in your Mac's Keychain, and installs it directly onto your device — in one command, with **no extport login and no App Store Connect setup**.

<figure style="margin: 1.5rem 0;">
  <video src="/videos/port-safari-demo.mp4" poster="/videos/port-safari-poster.jpg" autoplay loop muted playsinline controls style="display: block; width: 100%; border-radius: 12px; border: 1px solid var(--sl-color-hairline-shade); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);"></video>
</figure>

## Quick start

Requires **macOS** with **Xcode** installed.

```sh
# Paste any Chrome Web Store URL (or 32-char extension ID) → installs to ~/Applications
npx @extport/cli port safari https://chromewebstore.google.com/detail/new-tab-redirect/icpgjfneehieebagbmdbhnlpiopdcmna

# Install directly onto a connected iPhone or iPad via devicectl
npx @extport/cli port safari --platform ios https://chromewebstore.google.com/detail/new-tab-redirect/icpgjfneehieebagbmdbhnlpiopdcmna

# Export a .app (macOS) or .ipa (iOS) without installing
npx @extport/cli port safari https://chromewebstore.google.com/detail/new-tab-redirect/icpgjfneehieebagbmdbhnlpiopdcmna --output ./out
```

After a macOS install, the host app opens automatically with a setup guide — turn the extension on under **Safari → Settings → Extensions**. On iOS, enable it under **Settings → Apps → Safari → Extensions**.

## Supported inputs

Pass any of the following as `<source>`:

- **Chrome Web Store URL** (`chromewebstore.google.com/detail/...` or legacy `chrome.google.com/webstore/detail/...`)
- **32-character CWS extension ID** (e.g. `icpgjfneehieebagbmdbhnlpiopdcmna`)
- **Local `.crx`, `.zip`, or unpacked extension folder**

Everything runs **100% locally on your Mac** — nothing is uploaded to extport's servers.

:::note[Manifest V3 only]
Only Manifest V3 extensions are supported. If an extension declares Chrome-only APIs that Safari does not implement (such as `chrome.identity`, `chrome.offscreen`, or `chrome.sidePanel`), the CLI prints a warning up front and continues converting so you know what to expect.
:::

## Signing — zero certificate ceremony

Just like Xcode, `extport port safari` scans your Mac's ambient Keychain automatically:

- **One matching certificate** (`Apple Development` or `Developer ID Application`) → selected automatically, with the real Apple Developer Team ID extracted from the certificate's `OU` field.
- **Multiple certificates** → prompts you interactively to pick one (or pass `--sign <name|sha1>` to skip the prompt).
- **No certificate / `--no-sign`** → falls back to ad-hoc signing on macOS (enable **Safari → Develop → Allow Unsigned Extensions** to load it; signing into Xcode with a free Apple ID eliminates the per-restart reset). On iOS, `--no-sign --output ./out` exports an unsigned `.ipa` for sideloading.

:::tip[Free Apple ID works]
You don't need a paid $99/year Apple Developer membership to install on your own Mac or iPhone — signing in to **Xcode → Settings → Accounts** with a free Apple ID creates a local `Apple Development` certificate that Safari trusts without the unsigned-extensions toggle. On iOS, free-account installs expire after 7 days and use 2 of your 3 App ID slots (host app + `.appex`).
:::

## In-place updates

By default, bundle identifiers are derived deterministically (`dev.extport.<team|local>.<extension-id>`). Re-running `extport port safari <url>` when the upstream extension ships a new version installs over the existing app while keeping your Safari extension permissions and `browser.storage` data intact.

## Common flags

| Flag                      | Description                                                           |
| ------------------------- | --------------------------------------------------------------------- |
| `--platform <macos\|ios>` | Target platform (default: `macos`)                                    |
| `--output <path>`         | Export the built `.app` (macOS) or `.ipa` (iOS) instead of installing |
| `--sign <name\|sha1>`     | Pick a specific Keychain signing identity non-interactively           |
| `--no-sign`               | Skip Keychain lookup (ad-hoc on macOS; requires `--output` on iOS)    |
| `--device <name\|udid>`   | Target a specific physical iOS device (`--platform ios` only)         |
| `--bundle-id <id>`        | Override the deterministic bundle identifier                          |
| `--keep-project <dir>`    | Keep a copy of the generated self-contained `.xcodeproj`              |
| `--debug`                 | Stream raw converter, `xcodebuild`, and `devicectl` output            |

## Tested popular extensions

Verified on macOS 27.2 (Xcode 27.2 / Safari 27.2 `WKWebExtension` runtime, including macOS `Apple Development` signing and iOS `.ipa` + 375 px sheet layout checks):

| Extension                                                                                               | Version tested   | Status          | Notes                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------- | ---------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [uBlock Origin Lite](https://chromewebstore.google.com/detail/ddkjiahejlhfcafbddmgiahcphecmpfh)         | `2026.1124.1811` | Verified        | 6 default DNR rulesets + 34 dynamic rules + 4 scripts active; blocks live ads on `adblock-tester.com`; macOS signed `.app` & iOS `.ipa` verified                                    |
| [Dark Reader](https://chromewebstore.google.com/detail/eimadpbcbfnmbkopoojfekhnkhdbieeh)                | `4.9.135`        | Verified        | Injects dynamic dark theme styles & popup renders cleanly; macOS signed `.app` & iOS `.ipa` verified                                                                                |
| [Vimium](https://chromewebstore.google.com/detail/dbepggeogbaibhgnhhndojpepiihcmeb)                     | `2.4.2`          | Verified        | Background, content script, and popup load with zero errors (via Safari `webNavigation` shim); iOS `.ipa` verified (`resources/` auto-relocated)                                    |
| [React Developer Tools](https://chromewebstore.google.com/detail/fmkadmapgofadopljbjfkapdkoienihi)      | `8.0.0`          | Verified        | Registers all 5 `MAIN`/`ISOLATED` content scripts with zero errors (via `scripting.ExecutionWorld` shim)                                                                            |
| [SponsorBlock for YouTube](https://chromewebstore.google.com/detail/mnjggcdmjocbbbhaepdhchncahnbgone)   | `6.1.6`          | Verified        | Background and popup load with zero errors                                                                                                                                          |
| [Obsidian Web Clipper](https://chromewebstore.google.com/detail/cnjifjpddelmedmihgijeibhnjfabmlf)       | `1.8.5`          | Verified        | Background and popup load with zero errors (Chrome `sidePanel` unavailable in Safari)                                                                                               |
| [Refined GitHub](https://chromewebstore.google.com/detail/hlepfoohegkhhmjieoechaddaejaokhf)             | `26.11.6`        | Verified        | Background loads with zero errors across `Apple Development`, `Developer ID`, ad-hoc, and iOS                                                                                       |
| [OneTab](https://chromewebstore.google.com/detail/chphlpgkkbolifaimnlloiipkdnihall)                     | `2.24`           | Verified        | Background loads with zero errors (Chrome `omnibox` / `tabGroups` unavailable in Safari)                                                                                            |
| [SingleFile](https://chromewebstore.google.com/detail/mpiodijhokgodhhofbcjdecpffjipkle)                 | `1.41.1`         | Verified        | Background loads with zero errors (Safari lacks `chrome.downloads` / `sidePanel`)                                                                                                   |
| [Immersive Translate](https://chromewebstore.google.com/detail/bpoadfkcbjbfhfodiogcnhhhpibjhbnh)        | `1.35.4`         | Verified        | Background, DNR ruleset, and popup load cleanly                                                                                                                                     |
| [Bitwarden Password Manager](https://chromewebstore.google.com/detail/nngceckbapebfimnlniiiahkandclblb) | `2026.11.0`      | Verified        | Background boots and full Angular popup renders under Safari                                                                                                                        |
| [Stylus](https://chromewebstore.google.com/detail/clngdbkpkpeebahjckkjfobafhncgmne)                     | `2.4.18`         | Verified        | Background and popup boot cleanly (empty `_execute_action` command stripped; `permissions.contains`, `webNavigation`, `idle` shimmed)                                               |
| [Privacy Badger](https://chromewebstore.google.com/detail/pkehgijcmpdhfbdbbnkijodmdjhbjlgp)             | `2026.9.15.2`    | Partial         | Background boots and all 4 static DNR rulesets load (`webRequest` `ws://` filter & `setBadgeTextColor` shimmed); some Chrome RE2 dynamic `regexFilter` rules are rejected by WebKit |
| [Tampermonkey](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo)               | `5.5.1`          | Unsupported API | Builds, but MV3 userscript execution requires `chrome.userScripts`, which Safari does not implement (warned up front)                                                               |

## Publishing to the App Store instead?

`extport port safari` is for local personal installation on your own devices. When you're ready to ship your own extension to the Mac App Store and iOS App Store, see the [Safari publishing guide](/stores/safari/) (`extport safari-build`).
