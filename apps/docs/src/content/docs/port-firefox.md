---
title: Port Chrome extensions to Firefox
description: Convert any Manifest V3 Chrome extension into a Firefox-compatible .xpi (or run it live in Firefox) — no extport account or manual manifest editing required.
---

Have a Chrome extension you want to use in Firefox, Firefox Developer Edition, Nightly, Zen, Waterfox, or LibreWolf? `extport port firefox` downloads the extension straight from the Chrome Web Store (or reads a local `.crx`, `.zip`, or folder), rewrites Chrome-only Manifest V3 fields for Gecko, injects a lightweight runtime compatibility shim, and exports a ready-to-load `.xpi` — or launches Firefox with the extension already loaded via `--run`.

Everything runs **100% locally** on macOS, Linux, and Windows — no extport login required.

## Quick start

```sh
# Paste any Chrome Web Store URL (or 32-char extension ID) → writes ./<slug>-firefox.xpi
npx @extport/cli port firefox https://chromewebstore.google.com/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh

# Convert and launch Firefox immediately with the extension loaded (temporary add-on via RDP)
npx @extport/cli port firefox --run https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh

# Target a specific Firefox channel or browser binary
npx @extport/cli port firefox --run --firefox zen https://chromewebstore.google.com/detail/vimium/dbepggeogbaibhgnhhndojpepiihcmeb

# Export an unpacked Firefox extension directory instead of a .xpi
npx @extport/cli port firefox --unpacked --output ./out/dark-reader https://chromewebstore.google.com/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh
```

## Supported inputs

Pass any of the following as `<source>`:

- **Chrome Web Store URL** (`chromewebstore.google.com/detail/...` or legacy `chrome.google.com/webstore/detail/...`)
- **32-character CWS extension ID** (e.g. `ddkjiahejlhfcafbddmgiahcphecmpfh`)
- **Local `.crx`, `.zip`, `.xpi`, or unpacked extension folder**

## What `port firefox` transforms automatically

Firefox enforces stricter Manifest V3 rules than Chrome and runs MV3 background scripts as Event Pages (`background.scripts`) instead of Service Workers (`background.service_worker`). `extport port firefox` handles these differences automatically:

- **Background scripts**: converts `background.service_worker` → `background.scripts` (preserving `type: "module"`), and patches Webpack 5 `importScripts` chunk loaders to use CSP-safe `<script>` loading in Event Pages.
- **Deterministic Gecko ID**: preserves an existing `browser_specific_settings.gecko.id`, or derives a stable `<id|slug>@port.extport.dev` ID with `strict_min_version` (`128.0`) and `data_collection_permissions`.
- **UI & manifest compatibility**: converts `options_page` → `options_ui`, maps `side_panel` → Firefox's native `sidebar_action`, moves `userScripts` to `optional_permissions`, converts object `author` to a string, removes `incognito: "split"`, strips Chrome-only permissions/keys (`offscreen`, `sidePanel`, `commands`, `favicon`, `use_dynamic_url`, `navigate-to` CSP, `version_name`, `storage.managed_schema`).
- **Runtime compatibility shim**: bridges `chrome.sidePanel` → `browser.sidebarAction`, provides `scripting.ExecutionWorld`, `self.clients`, and `navigator.serviceWorker` Event Page shims, strips unsupported `declarativeNetRequest` `responseHeaders` conditions, and makes `permissions.contains()` return `false` cleanly for stripped Chrome-only permissions.

:::note[Installing `.xpi` files in Firefox]
- **Any Firefox (including Release)**: run with `--run` (loads automatically via Firefox Remote Debugging Protocol), or open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** and select the `.xpi` or unpacked `manifest.json`.
- **Permanent unsigned install** (Firefox Developer Edition, Nightly, ESR, Zen, Waterfox, LibreWolf): set `xpinstall.signatures.required = false` in `about:config` and drag the `.xpi` into the browser.
:::

## Common flags

| Flag                        | Description                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--output <path>`           | Export `.xpi` (or unpacked directory with `--unpacked`) to a file or directory (default: `./<slug>-firefox.xpi`)           |
| `--unpacked`                | Export an unpacked extension directory instead of packaging a `.xpi`                                                       |
| `--run`                     | Launch Firefox with the converted extension temporarily installed via RDP                                                  |
| `--firefox <channel\|path>` | Browser channel (`firefox`, `dev`, `nightly`, `esr`, `zen`, `waterfox`, `librewolf`) or executable path (requires `--run`) |
| `--gecko-id <id>`           | Override `browser_specific_settings.gecko.id`                                                                              |
| `--min-version <ver>`       | Override `browser_specific_settings.gecko.strict_min_version` (default: `128.0`)                                           |
| `--keep-unpacked <dir>`     | Keep a copy of the converted unpacked directory alongside the `.xpi`                                                       |
| `--debug`                   | Print detailed manifest transformations and Firefox process output                                                         |

## Tested popular extensions

Verified in real Mozilla Firefox 159.0 via `extport port firefox` and RDP (`--run`), with **0 manifest warnings** and `backgroundScriptStatus = RUNNING` across all 14 extensions:

| Extension                                                                                               | Version tested   | Status   | Notes                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ---------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| [uBlock Origin Lite](https://chromewebstore.google.com/detail/ddkjiahejlhfcafbddmgiahcphecmpfh)         | `2026.1124.1811` | Verified | 6 DNR rulesets + 258 dynamic rules + 4 scripts active; scores **91/100** on `adblock-tester.com` with 0 errors  |
| [Dark Reader](https://chromewebstore.google.com/detail/eimadpbcbfnmbkopoojfekhnkhdbieeh)                | `4.9.135`        | Verified | Injects dynamic dark theme (`10` `<style class="darkreader">`) and popup renders cleanly; live CWS URL verified |
| [Bitwarden Password Manager](https://chromewebstore.google.com/detail/nngceckbapebfimnlniiiahkandclblb) | `2026.11.0`      | Verified | Webpack 5 `importScripts` chunk loader auto-patched for Event Pages; full Angular popup renders cleanly         |
| [Vimium](https://chromewebstore.google.com/detail/dbepggeogbaibhgnhhndojpepiihcmeb)                     | `2.4.2`          | Verified | Background and content scripts load with 0 errors                                                               |
| [SponsorBlock for YouTube](https://chromewebstore.google.com/detail/mnjggcdmjocbbbhaepdhchncahnbgone)   | `6.1.6`          | Verified | Background loads with 0 errors                                                                                  |
| [React Developer Tools](https://chromewebstore.google.com/detail/fmkadmapgofadopljbjfkapdkoienihi)      | `8.0.0`          | Verified | Registers all 5 content scripts with 0 errors                                                                   |
| [SingleFile](https://chromewebstore.google.com/detail/mpiodijhokgodhhofbcjdecpffjipkle)                 | `1.41.1`         | Verified | Loads with 0 errors (`navigator.serviceWorker` Event Page stub + `side_panel` → `sidebar_action`)               |
| [Immersive Translate](https://chromewebstore.google.com/detail/bpoadfkcbjbfhfodiogcnhhhpibjhbnh)        | `1.35.4`         | Verified | 1 DNR ruleset and popup load cleanly with 0 errors                                                              |
| [Refined GitHub](https://chromewebstore.google.com/detail/hlepfoohegkhhmjieoechaddaejaokhf)             | `26.11.6`        | Verified | Loads with 0 errors; preserves existing `browser_specific_settings.gecko.id`                                    |
| [Privacy Badger](https://chromewebstore.google.com/detail/pkehgijcmpdhfbdbbnkijodmdjhbjlgp)             | `2026.9.15.2`    | Verified | 4 DNR rulesets + 4,988 dynamic rules + popup load with 0 JS errors (`author` object normalized to string)       |
| [Obsidian Web Clipper](https://chromewebstore.google.com/detail/cnjifjpddelmedmihgijeibhnjfabmlf)       | `1.8.5`          | Verified | Loads with 0 errors (`side_panel` → `sidebar_action` bridged)                                                   |
| [OneTab](https://chromewebstore.google.com/detail/chphlpgkkbolifaimnlloiipkdnihall)                     | `2.24`           | Verified | Background and popup load cleanly with 0 errors                                                                 |
| [Stylus](https://chromewebstore.google.com/detail/clngdbkpkpeebahjckkjfobafhncgmne)                     | `2.4.18`         | Verified | Loads with 0 errors; 1 dynamic DNR rule installed (`self.clients` + `responseHeaders` strip)                    |
| [Tampermonkey](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo)               | `5.5.1`          | Verified | Loads with 0 errors (`userScripts` automatically moved to `optional_permissions`)                               |

## Publishing to Firefox Add-ons (AMO) instead?

`extport port firefox` is for local personal conversion and testing. When you're ready to publish your own extension to AMO, see the [Firefox publishing guide](/stores/firefox/).
