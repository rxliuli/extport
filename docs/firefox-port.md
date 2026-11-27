# Local Firefox porting (`extport port firefox`) — design

Status: **implemented and verified** against real Mozilla Firefox 159.0 across
14 top Chrome Web Store MV3 extensions (uBlock Origin Lite, Dark Reader,
Bitwarden, Vimium, SponsorBlock, React Developer Tools, SingleFile, Immersive
Translate, Refined GitHub, Privacy Badger, Obsidian Web Clipper, OneTab,
Stylus, and Tampermonkey — 14/14 installed cleanly with `RUNNING` backgrounds
and zero manifest warnings).

## Goal

Let any user (macOS, Linux, or Windows) take any Manifest V3 Chrome extension —
from a Chrome Web Store URL, 32-char extension ID, or local `.crx` / `.zip` /
unpacked folder — and convert it into a Firefox-compatible MV3 `.xpi` (or
unpacked directory), and optionally launch it directly inside Firefox via
`--run` with **no extport login and no external `web-ext` dependency**.

## CLI interface

```sh
extport port firefox <source> [options]
```

| Argument / Flag             | Default                                       | Description                                                                                                    |
| --------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `<source>`                  | _(required)_                                  | CWS URL, 32-char extension ID, or local `.crx` / `.zip` / `.xpi` / directory                                   |
| `--output <path>`           | `./<slug>-firefox.xpi`                        | Export `.xpi` or unpacked directory (`--unpacked`) to this path                                                |
| `--unpacked`                | `false`                                       | Export an unpacked directory instead of packaging a `.xpi`                                                     |
| `--gecko-id <id>`           | _(existing or `<id\|slug>@port.extport.dev`)_ | Override `browser_specific_settings.gecko.id`                                                                  |
| `--min-version <ver>`       | `128.0`                                       | Override `browser_specific_settings.gecko.strict_min_version`                                                  |
| `--run`                     | `false`                                       | Launch Firefox (or a Firefox-based browser) and install the extension via RDP                                  |
| `--firefox <channel\|path>` | _(auto-discover)_                             | Channel (`firefox`, `dev`, `nightly`, `esr`, `zen`, `waterfox`, `librewolf`) or executable path (`--run` only) |
| `--keep-unpacked <dir>`     | _(discard temp)_                              | Copy the converted unpacked directory to `<dir>`                                                               |
| `--debug`                   | `false`                                       | Print detailed manifest transforms and Firefox process output                                                  |

## Transformations

1. **Source resolution (`port-source.ts`)**: shared with `extport port safari` — CWS CRX2/CRX3 download + Zip Slip–safe extraction.
2. **Manifest conversion (`firefox-port-compat.ts`)**:
   - `background.service_worker` → `background.scripts` (preserving `type: "module"`).
   - `browser_specific_settings.gecko` (`id`, `strict_min_version`, `data_collection_permissions`).
   - `options_page` → `options_ui`, `side_panel` → `sidebar_action`, `incognito: "split"` removed, object `author` normalized to string, `options_ui.browser_style` removed.
   - `userScripts` moved from `permissions` → `optional_permissions`; Firefox-required-only permissions (`contextMenus`, `identity`, etc.) promoted from `optional_permissions` → `permissions`; Chrome-only permissions (`offscreen`, `sidePanel`, `commands`, `favicon`, `fontSettings`, `readingList`, `chrome://*`, etc.) stripped.
   - Chrome-only manifest keys (`update_url`, `key`, `minimum_chrome_version`, `offline_enabled`, `$schema`, `oauth2`, `sandbox`, `externally_connectable`, `version_name`, `storage.managed_schema`, `web_accessible_resources[].use_dynamic_url` / `extension_ids`, CSP `sandbox` & `navigate-to`) stripped.
3. **Runtime compatibility shim (`__extport_firefox_runtime.js`)**:
   - Bridges `chrome.sidePanel` → `browser.sidebarAction`.
   - Polyfills `scripting.ExecutionWorld`, `action.setBadgeTextColor` / `getBadgeTextColor`, `webRequest.On*Options`, Event Page `globalThis.clients` & `navigator.serviceWorker`.
   - Wraps `permissions.contains` / `request` / `remove` for stripped Chrome-only permissions and strips unsupported `declarativeNetRequest` `responseHeaders` / `excludedResponseHeaders` conditions.
   - Patches Webpack 5 `importScripts` SW chunk loaders in non-module background scripts to fall back to CSP-safe `<script>` loading in Firefox Event Pages.
4. **Packaging & runner (`firefox-port-package.ts`, `firefox-port-runner.ts`)**:
   - `.xpi` built with `fflate.zipSync` using POSIX paths.
   - `--run` discovers Firefox / Dev Edition / Nightly / Zen / Waterfox / LibreWolf and uses a zero-dependency Node `net.Socket` Firefox RDP client (`getRoot` → `installTemporaryAddon` → `listAddons`).

## Verified popular extensions (2026-11-28, Mozilla Firefox 159.0)

All 14 extensions converted via `extport port firefox` installed cleanly into real Firefox 159.0 via RDP with `backgroundScriptStatus = RUNNING` and **0 manifest warnings**:

| Extension                                                                                          | Version          | Manifest warnings | Runtime result                                                                                          |
| -------------------------------------------------------------------------------------------------- | ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| [uBlock Origin Lite](https://chromewebstore.google.com/detail/ddkjiahejlhfcafbddmgiahcphecmpfh)    | `2026.1124.1811` | 0                 | 0 errors; 6 DNR rulesets + 258 dynamic rules + 4 scripts; **91/100** on `adblock-tester.com`            |
| [Dark Reader](https://chromewebstore.google.com/detail/eimadpbcbfnmbkopoojfekhnkhdbieeh)           | `4.9.135`        | 0                 | 0 errors; darkens page (`10` `<style class="darkreader">`) + popup (`346` nodes); live CWS URL verified |
| [Bitwarden](https://chromewebstore.google.com/detail/nngceckbapebfimnlniiiahkandclblb)             | `2026.11.0`      | 0                 | Webpack 5 `importScripts` chunk loader patched; Angular popup renders (`164` nodes)                     |
| [Vimium](https://chromewebstore.google.com/detail/dbepggeogbaibhgnhhndojpepiihcmeb)                | `2.4.2`          | 0                 | 0 errors                                                                                                |
| [SponsorBlock](https://chromewebstore.google.com/detail/mnjggcdmjocbbbhaepdhchncahnbgone)          | `6.1.6`          | 0                 | 0 errors                                                                                                |
| [React Developer Tools](https://chromewebstore.google.com/detail/fmkadmapgofadopljbjfkapdkoienihi) | `8.0.0`          | 0                 | 0 errors; 5 content scripts registered                                                                  |
| [SingleFile](https://chromewebstore.google.com/detail/mpiodijhokgodhhofbcjdecpffjipkle)            | `1.41.1`         | 0                 | 0 errors (`navigator.serviceWorker` stub + `side_panel → sidebar_action`)                               |
| [Immersive Translate](https://chromewebstore.google.com/detail/bpoadfkcbjbfhfodiogcnhhhpibjhbnh)   | `1.35.4`         | 0                 | 0 errors; 1 DNR ruleset + popup (`1228` nodes)                                                          |
| [Refined GitHub](https://chromewebstore.google.com/detail/hlepfoohegkhhmjieoechaddaejaokhf)        | `26.11.6`        | 0                 | 0 errors; preserves existing Gecko ID                                                                   |
| [Privacy Badger](https://chromewebstore.google.com/detail/pkehgijcmpdhfbdbbnkijodmdjhbjlgp)        | `2026.9.15.2`    | 0                 | 0 JS errors; 4 rulesets + 4,988 dynamic rules + popup (`113` nodes); `author` object normalized         |
| [Obsidian Web Clipper](https://chromewebstore.google.com/detail/cnjifjpddelmedmihgijeibhnjfabmlf)  | `1.8.5`          | 0                 | 0 errors (`side_panel → sidebar_action` bridged)                                                        |
| [OneTab](https://chromewebstore.google.com/detail/chphlpgkkbolifaimnlloiipkdnihall)                | `2.24`           | 0                 | 0 errors; popup renders (`18` nodes)                                                                    |
| [Stylus](https://chromewebstore.google.com/detail/clngdbkpkpeebahjckkjfobafhncgmne)                | `2.4.18`         | 0                 | 0 errors; 1 dynamic DNR rule installed (`self.clients` + `responseHeaders` strip)                       |
| [Tampermonkey](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo)          | `5.5.1`          | 0                 | 0 errors (`userScripts` moved to `optional_permissions`)                                                |
