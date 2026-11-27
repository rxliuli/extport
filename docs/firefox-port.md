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
