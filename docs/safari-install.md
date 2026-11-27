# Local browser porting (`extport port safari`) — design

Status: **implemented and verified** on macOS 27.2 (Xcode 27.2 / Safari 27.2)
against 14 popular Chrome Web Store MV3 extensions (including uBlock Origin
Lite, Dark Reader, Vimium, React Developer Tools, Bitwarden, SponsorBlock,
SingleFile, Immersive Translate, Refined GitHub, Privacy Badger, Obsidian Web
Clipper, OneTab, Stylus, and Tampermonkey) plus New Tab Redirect on a physical
Mac and iPhone via `devicectl`.

## Goal

Let a macOS user take any Manifest V3 Chrome extension — starting with a
Chrome Web Store URL or extension ID, or a local `.crx` / `.zip` / unpacked
directory — and convert, sign with an ambient Keychain certificate (when
available), and install it directly onto their own Mac or connected iPhone in
one command, with **no extport login, no Xcode GUI ceremony, and no
third-party CRX download site**.

This command lives under `extport port <target>` (starting with `safari`, leaving
room for future targets such as `firefox`) and is strictly for **local, personal
installation on the user's own devices**. It does not touch extport's server,
does not upload to App Store Connect, and does not attempt notarization or
cross-machine distribution.

## Contrast with `extport safari-build`

|          | `extport safari-build`                       | `extport port safari`                                                                                             |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Audience | Extension author publishing to the App Store | Power user installing an extension on their own Mac / iPhone                                                      |
| Input    | Existing `.xcodeproj`                        | CWS URL / 32-char ID / `.crx` / `.zip` / directory                                                                |
| Auth     | App Store Connect `.p8` key + Team ID        | Ambient Keychain cert (optional); zero extport auth                                                               |
| Output   | Uploads binary to App Store Connect          | Installs to `~/Applications` (macOS) or connected iPhone (`devicectl`), or exports `.app` / `.ipa` via `--output` |
| Boundary | Never converts, never submits                | Never uploads to ASC, never notarizes                                                                             |

Keeping these as separate subcommands preserves `safari-build`'s clean
publishing contract (`docs/safari-pipeline.md`).

## CLI interface

```sh
extport port safari <source> [options]
```

macOS only (`process.platform === 'darwin'`; fails fast on other OSes).

### Arguments & flags

| Argument / Flag             | Type                  | Default            | Description                                                                                                                                       |
| --------------------------- | --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<source>`                  | positional (required) | —                  | CWS URL, 32-char extension ID, or local `.crx` / `.zip` / directory                                                                               |
| `--platform`                | `macos` \| `ios`      | `macos`            | Target platform to build and install                                                                                                              |
| `--output <path>`           | string                | _(omit → install)_ | Export the built `.app` (macOS) or `.ipa` (iOS) instead of installing. Accepts either a target directory or an explicit `.app` / `.ipa` file path |
| `--sign <identity>`         | string                | _(auto-discover)_  | Signing identity SHA-1 or name substring from Keychain. Mutually exclusive with `--no-sign`                                                       |
| `--no-sign`                 | boolean               | `false`            | Skip Keychain lookup: ad-hoc sign on macOS, unsigned `.ipa` on iOS (requires `--output` on iOS)                                                   |
| `--team-id <id>`            | string                | _(from cert `OU`)_ | Override the Apple Developer Team ID extracted from the selected certificate                                                                      |
| `--bundle-id <id>`          | string                | _(deterministic)_  | Override the generated bundle identifier                                                                                                          |
| `--device <id\|name>`       | string                | _(auto-discover)_  | Target physical iOS device (`--platform ios` only)                                                                                                |
| `--keep-project <dir>`      | string                | _(discard temp)_   | Copy the generated self-contained `.xcodeproj` directory to `<dir>`                                                                               |
| `--macos-deployment-target` | string                | `12.0`             | Minimum macOS version (matches `safari-build`)                                                                                                    |
| `--debug`                   | boolean               | `false`            | Stream raw `safari-web-extension-converter` / `xcodebuild` / `devicectl` output                                                                   |

## Pipeline

```
<source>
  │
  ▼ 1. Resolve & unpack (CWS URL/ID → CRX → unzip, or local .crx/.zip/dir)
unpacked extension dir
  │
  ▼ 2. Inspect manifest.json (enforce MV3, resolve __MSG_*__ name, normalize version, warn on unsupported Safari APIs)
ExtensionMeta
  │
  ▼ 3. Discover signing identity from Keychain (auto / prompt if multiple / fallback)
SigningSelection
  │
  ▼ 4. Convert via shared @extport/safari-xcode (converter + pbxproj/xcproj patch + setup page)
temp .xcodeproj (optionally copied to --keep-project)
  │
  ▼ 5. Build & sign via xcodebuild (platform-specific signing rules)
built .app
  │
  ▼ 6. Install (~/Applications + open, or devicectl install) OR export (--output)
```

All temporary files live in a single `mkdtemp(join(tmpdir(), 'extport-safari-install-'))`
directory and are cleaned up in a `finally` block.

---

## Stage details

### 1. Source resolution & CRX unpacking

Resolution order:

1. **Local path** (checked first when `existsSync(source)` is true):
   - Directory: verify `manifest.json` exists directly inside it.
   - `.crx`: parse CRX header and unzip payload.
   - `.zip`: unzip payload; if no root `manifest.json` exists and there is exactly one top-level directory containing `manifest.json`, descend into it.
   - Anything else: fail with a clear error.
2. **Chrome Web Store URL or ID**:
   - Accept:
     - `https://chromewebstore.google.com/detail/<slug>/<id>` (and optional trailing segments/query)
     - `https://chrome.google.com/webstore/detail/<slug>/<id>`
     - Bare 32-char extension ID matching `/^[a-p]{32}$/`
   - Download CRX locally from Chrome's update endpoint:
     ```
     https://clients2.google.com/service/update2/crx?response=redirect&prodversion=<ver>&acceptformat=crx2,crx3&x=id%3D<id>%26uc
     ```
     (`prodversion` defaults to a current Chrome version, overridable via `EXTPORT_CHROME_VERSION` if Google ever raises the floor).
   - Handle `204 No Content` / non-200 explicitly: explain that the extension may be unlisted, region-restricted, removed, or unavailable for the requested Chrome version.
3. **CRX2 / CRX3 binary parser** (zero new dependencies, feeds `fflate.unzipSync`):
   - Validate magic `Cr24` (`0x34327243`).
   - CRX3 (`version === 3`): ZIP payload starts at `12 + uint32LE(8)`.
   - CRX2 (`version === 2`): ZIP payload starts at `16 + uint32LE(8) + uint32LE(12)`.
   - Guard against Zip Slip on extraction: reject any archive entry whose resolved path escapes the extraction root.

### 2. Manifest validation, localization & Safari preflight

- **MV3 only**: if `manifest.manifest_version !== 3`, fail immediately (`Only Manifest V3 extensions are supported (got manifest_version: ...)`). CWS has already sunset MV2.
- **Localized name (`__MSG_<key>__`)**: many CWS extensions set `"name": "__MSG_appName__"`. Resolve against `_locales/<default_locale>/messages.json` using Chrome's case-insensitive key lookup, falling back to `en` / `en_US` / first available locale, and finally the extension ID or directory name.
- **App name sanitization**: strip control characters and path separators (`/`, `:`) before passing to `--app-name` so the generated `.xcodeproj` and `.app` bundle names are always valid macOS filenames.
- **Version normalization**:
  - Chrome extensions allow 1–4 dot-separated integers (e.g. `2.1`, `1.2.3.4`, `2026.11.27`).
  - `MARKETING_VERSION` (`CFBundleShortVersionString`): take up to 3 numeric segments with leading zeros stripped (`1.2.3.4` → `1.2.3`, `2.0` → `2.0`).
  - `CURRENT_PROJECT_VERSION` (`CFBundleVersion`): safe positive integer/dotted version that never produces `NaN` on 2-segment versions (fixing the existing `parseProjectVersion` edge case when shared).
- **Safari unsupported API warnings** (warn & continue, never block):
  Inspect `manifest.permissions`, `manifest.optional_permissions`, and top-level manifest keys for known Chrome-only APIs and print a concise warning per hit:
  - `identity` → `chrome.identity` (OAuth / Google account token flows)
  - `offscreen` → `chrome.offscreen` (offscreen documents)
  - `sidePanel` / top-level `side_panel` → `chrome.sidePanel` (browser side panel)
  - Plus common secondary hits (`debugger`, `tabGroups`, `gcm`, `enterprise.*`) if declared.

### 3. Deterministic Bundle ID

Default format (overridable via `--bundle-id`):

```
dev.extport.<scope>.<slug>
```

- `<scope>`: lowercased `teamId` when signed (e.g. `n2x78tuufg`), or `local` when unsigned/ad-hoc.
- `<slug>`:
  - For CWS sources: the 32-character extension ID (stable even if the extension is renamed).
  - For local sources: sanitized ASCII slug of the extension name, falling back to an 8-char SHA-256 prefix of the manifest name when non-ASCII.
- Why:
  1. Scoped per Team ID so free Personal Teams never collide with other users' registered App IDs on Apple's servers.
  2. Deterministic for the same user + extension, so re-running `extport safari-install <url>` after an upstream CWS update installs over the existing app and preserves Safari extension settings, permissions, and `browser.storage`.

### 4. Keychain certificate discovery & Team ID extraction

Discover signing identities from the ambient Keychain — no `.p12` files or temporary keychains:

1. Run `security find-identity -v -p codesigning` to get valid identities (`sha1`, `name`).
2. Classify and filter by platform:
   - **macOS**: accept `Apple Development` (and legacy `Mac Developer`) and `Developer ID Application`. Exclude `Apple Distribution` (cannot be launched locally).
   - **iOS**: accept `Apple Development` (and legacy `iPhone Developer`). Exclude `Developer ID Application` and `Apple Distribution`.
3. **Resolve real Team ID from X.509 `OU` (critical)**:
   - Observed directly on Xcode 27.2: `Apple Development: NAME (DF3BVL824L)` puts the _personal/user ID_ in CN parentheses, while the actual Team ID (`N2X78TUUFG`) lives in the certificate's Subject `OU` field.
   - Fetch matching PEM certificates via `security find-certificate -a -Z -p` (indexed by SHA-1 hash so duplicate CNs never collide) and read `OU=` via `openssl x509 -noout -subject`.
4. Selection policy:
   - `--no-sign`: bypass Keychain (macOS → ad-hoc; iOS → unsigned `.ipa`, requires `--output`).
   - `--sign <query>`: match by exact SHA-1 or case-insensitive name substring; fail with the available list if 0 or ambiguous.
   - Automatic:
     - **0 matches**:
       - macOS: fall back to ad-hoc signing (`-`) and print a clear note explaining Safari's "Allow Unsigned Extensions" setting and that signing into a free Apple ID in Xcode eliminates the per-restart reset.
       - iOS with `--output`: fall back to unsigned `.ipa` with a note about sideloading (AltStore / SideStore).
       - iOS without `--output`: fail fast explaining that direct iOS device install requires an `Apple Development` certificate (or pass `--no-sign --output <path>` to export an unsigned `.ipa`).
     - **1 match**: auto-select and log the chosen identity.
     - **2+ matches**: in a TTY, prompt with `@clack/prompts` `select` (listing each identity with its kind and Team ID, plus an explicit "No signing (ad-hoc / unsigned)" choice); in non-TTY, fail with instructions to pass `--sign` or `--no-sign`.

### 5. Conversion & shared `@extport/safari-xcode` workspace package

**License boundary**: `packages/shared` is Elastic License 2.0, while `@extport/cli` and `@extport/wxt` are MIT. Do **not** place shared Safari conversion code in `packages/shared`.

Instead, extract the existing conversion code from `packages/wxt` into a new private MIT workspace package:

```
packages/safari-xcode/
  package.json          # "name": "@extport/safari-xcode", "private": true, "license": "MIT"
  src/
    index.ts            # public exports
    safari-xcode.ts     # generic convertExtensionToXcodeProject() + pbxproj patching
    safari-xcproj.ts    # Xcode 27.2 JSON project.xcproj patching
    safari-setup-page.ts
    exec.ts
```

- Both `packages/wxt` and `packages/cli` list `"@extport/safari-xcode": "workspace:*"` in `devDependencies`.
- Both packages already bundle via `tsdown` (`dist/`), so `@extport/safari-xcode` is inlined into both published bundles with zero new published npm packages and zero runtime dependencies added.
- `convertExtensionToXcodeProject` accepts explicit `sourceDir`, `outputDir`, `projectName`, `version`, `bundleIdentifier`, `appCategory`, `developmentTeam`, `projectType`, `openProject`, and `copyResources` (`--app-name` + `--copy-resources` passed to `xcrun safari-web-extension-converter`).
- `@extport/wxt` keeps its existing `convertToXcodeProject` wrapper and all existing tests passing without behavioral change.

### 6. Build & signing invocations (`xcodebuild`)

Unlike `safari-build` (which runs `archive` + `-exportArchive` with an ASC key), `safari-install` runs `xcodebuild build` into an isolated `-derivedDataPath` under the temp directory:

- **macOS — `Apple Development`**:

  ```
  xcodebuild -project <proj> -scheme <scheme> -configuration Release
    -derivedDataPath <tmp>/dd build
    CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<teamId>
    -allowProvisioningUpdates
    MACOSX_DEPLOYMENT_TARGET=<target>
    ONLY_ACTIVE_ARCH=YES
  ```

  (Uses Xcode's stored Apple ID session when provisioning is needed; building only the host architecture keeps local installs fast.)

- **macOS — `Developer ID Application`**:
  Automatic signing in Xcode selects `Apple Development` for `build` rather than `Developer ID Application`. When the user selects a `Developer ID Application` identity, sign explicitly:

  ```
  xcodebuild -project <proj> -scheme <scheme> -configuration Release
    -derivedDataPath <tmp>/dd build
    CODE_SIGN_STYLE=Manual
    CODE_SIGN_IDENTITY=<sha1>
    DEVELOPMENT_TEAM=<teamId>
    CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO
    MACOSX_DEPLOYMENT_TARGET=<target>
    ONLY_ACTIVE_ARCH=YES
  ```

  (Verified against real Xcode 27.2 on macOS during implementation; if nested `.appex` signing needs an explicit pass, sign inner `.appex` then outer `.app` with `codesign --force --options runtime --preserve-metadata=entitlements`.)

- **macOS — ad-hoc (`--no-sign` / fallback)**:

  ```
  xcodebuild -project <proj> -scheme <scheme> -configuration Release
    -derivedDataPath <tmp>/dd build
    CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=-
    CODE_SIGNING_REQUIRED=NO AD_HOC_CODE_SIGNING_ALLOWED=YES
    MACOSX_DEPLOYMENT_TARGET=<target>
    ONLY_ACTIVE_ARCH=YES
  ```

- **iOS — `Apple Development`**:

  ```
  xcodebuild -project <proj> -scheme <scheme> -configuration Release
    -sdk iphoneos -derivedDataPath <tmp>/dd build
    CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<teamId>
    -allowProvisioningUpdates
  ```

  Translate common Xcode signing failures into actionable hints (e.g. not signed in to Xcode Accounts, or no iOS device registered to the team yet).

- **iOS — unsigned (`--no-sign --output`)**:
  ```
  xcodebuild -project <proj> -scheme <scheme> -configuration Release
    -sdk iphoneos -derivedDataPath <tmp>/dd build
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=
  ```

### 7. Installation & export

- **macOS install (default)**:
  1. Target path: `~/Applications/<AppName>.app` (created with `mkdir -p ~/Applications`; no `sudo`).
  2. If an older app already exists at the target path, remove it cleanly before copying.
  3. Copy via `/usr/bin/ditto <built.app> <dest.app>` so symlinks, code signatures, and nested `.appex` bundles stay intact.
  4. Launch via `open <dest.app>` so LaunchServices / PlugInKit registers the `.appex` with Safari and the setup guide window opens immediately.
  5. Print concise next steps (and the "Allow Unsigned Extensions" reminder if ad-hoc signed).

- **macOS export (`--output <path>`)**:
  - If `<path>` ends with `.app`, `ditto` directly to `<path>`; otherwise `ditto` to `<path>/<AppName>.app`.
  - Do not copy to `~/Applications` or `open` the app.

- **iOS install (default)**:
  1. Run `xcrun devicectl list devices --json-output <tmp>/devices.json`.
  2. Parse devices supporting both the current `properties.{hardware,connection,software,state}` schema (Xcode 27+) and the legacy `{hardwareProperties,connectionProperties,deviceProperties}` fields. Filter to physical iOS/iPadOS devices (`visibilityClass !== 'simulators'` and `reality === 'physical'` when present).
  3. Match `--device` if supplied; otherwise auto-pick when 1 paired/connected device exists, prompt via `@clack/prompts` when multiple exist, or fail with a clear hint (plug in / pair iPhone, or use `--output` to export an `.ipa`).
  4. Install via `xcrun devicectl device install app --device <identifier> <built.app>`.
  5. Print iOS enable steps (`Settings → Apps → Safari → Extensions`) plus the free Personal Team note (7-day expiry, 2 of 3 App ID slots used by host app + `.appex`).

- **iOS export (`--output <path>`)**:
  - Assemble `<tmp>/ipa/Payload/<AppName>.app` via `ditto`, then zip with `/usr/bin/ditto -c -k --sequesterRsrc --keepParent <tmp>/ipa/Payload <out.ipa>`.
  - If `<path>` ends with `.ipa`, write directly to `<path>`; otherwise write `<path>/<AppName>.ipa`.

---

## Deliberately out of scope

- **Manifest V2 extensions**: rejected up front.
- **Notarization / `.dmg` creation / App Store distribution**: this command is for local personal use; distribution stays outside scope.
- **`.p12` / temporary Keychain management**: signing relies solely on ambient Keychain identities, consistent with `safari-build`.
- **Automatic iOS Simulator installs / Chrome profile scraping**: can be considered later if needed, not part of v1.

---

## Verification plan

1. **Unit tests (`vitest`)** across `packages/safari-xcode` and `packages/cli/test`:
   - CWS URL / ID parsing (new URL, legacy URL, query params, bare ID, invalid inputs).
   - CRX2 & CRX3 header stripping + Zip Slip rejection + single-root zip unwrapping.
   - Manifest validation (MV2 rejection, `__MSG_*__` case-insensitive locale lookup, version normalization, unsupported API warnings).
   - Deterministic Bundle ID generation (CWS ID, local ASCII name, non-ASCII name, Team ID vs `local`).
   - `security find-identity` + `OU` Team ID parsing + platform filtering + interactive/flag selection rules.
   - `devicectl` JSON parsing (both `properties.*` and legacy fields, simulator filtering).
   - `xcodebuild` argument builders for all 5 build/signing modes.
2. **Real macOS end-to-end verification (mandatory)**:
   - Run the built CLI against a real public MV3 Chrome Web Store extension URL:
     - macOS with local `Apple Development` cert → verify `.app` signature (`codesign --verify --deep --strict`), nested `.appex`, install/export via `--output`.
     - macOS with `Developer ID Application` cert via `--sign` → verify signature and nested `.appex`.
     - macOS with `--no-sign --output` → verify ad-hoc `.app` builds cleanly.
     - iOS with `--no-sign --output` (and signed iOS build if a device/team is available) → verify `.ipa` layout (`Payload/<App>.app/PlugIns/*.appex`).
   - Confirm `@extport/wxt` and `@extport/cli` both pass `pnpm test`, `pnpm typecheck`, and `pnpm build`.

## Verified popular extensions (2026-11-28, Safari 27.2 / Xcode 27.2)

Verified against macOS 27.2 `WKWebExtension` runtime (plus macOS `Apple Development` / `Developer ID` / ad-hoc builds and iOS `.ipa` + 375 px layout checks):

| Extension             | CWS ID                             | Version          | Status          | Runtime & build result                                                                                                                                                          |
| --------------------- | ---------------------------------- | ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| uBlock Origin Lite    | `ddkjiahejlhfcafbddmgiahcphecmpfh` | `2026.1124.1811` | Verified        | 0 errors; 6 DNR rulesets + 34 dynamic rules + 4 scripts; blocks live ads on `adblock-tester.com` (badge `8`); signed `.app` & iOS `.ipa` (375 px) verified                      |
| Dark Reader           | `eimadpbcbfnmbkopoojfekhnkhdbieeh` | `4.9.135`        | Verified        | 0 errors; turns light pages dark (`9` `<style class="darkreader">`); live CWS URL + signed `.app` + PlugInKit + iOS `.ipa` (375 px) verified                                    |
| Bitwarden             | `nngceckbapebfimnlniiiahkandclblb` | `2026.11.0`      | Verified        | Background boots and full Angular popup renders under Safari UA                                                                                                                 |
| Vimium                | `dbepggeogbaibhgnhhndojpepiihcmeb` | `2.4.2`          | Verified        | 0 errors (`webNavigation` event shim); signed `.app` & iOS `.ipa` (`resources/` auto-relocated, 375 px popup no overflow) verified                                              |
| SponsorBlock          | `mnjggcdmjocbbbhaepdhchncahnbgone` | `6.1.6`          | Verified        | 0 errors; background & popup render cleanly                                                                                                                                     |
| React Developer Tools | `fmkadmapgofadopljbjfkapdkoienihi` | `8.0.0`          | Verified        | 0 errors (`scripting.ExecutionWorld` shim); all 5 content scripts registered                                                                                                    |
| SingleFile            | `mpiodijhokgodhhofbcjdecpffjipkle` | `1.41.1`         | Verified        | 0 errors; background boots cleanly (`chrome.downloads` / `sidePanel` unsupported in Safari)                                                                                     |
| Immersive Translate   | `bpoadfkcbjbfhfodiogcnhhhpibjhbnh` | `1.35.4`         | Verified        | Background, DNR ruleset, and popup load cleanly                                                                                                                                 |
| Refined GitHub        | `hlepfoohegkhhmjieoechaddaejaokhf` | `26.11.6`        | Verified        | 0 errors across `Apple Development`, `Developer ID`, ad-hoc, and iOS                                                                                                            |
| Privacy Badger        | `pkehgijcmpdhfbdbbnkijodmdjhbjlgp` | `2026.9.15.2`    | Partial         | `webRequest` `ws://` filter, `On*Options` enums & `setBadgeTextColor` shimmed; all 4 static DNR rulesets active, some Chrome RE2 dynamic `regexFilter` rules rejected by WebKit |
| Obsidian Web Clipper  | `cnjifjpddelmedmihgijeibhnjfabmlf` | `1.8.5`          | Verified        | 0 errors; background & popup render cleanly (`sidePanel` unsupported in Safari)                                                                                                 |
| OneTab                | `chphlpgkkbolifaimnlloiipkdnihall` | `2.24`           | Verified        | 0 errors; background boots cleanly (`omnibox` / `tabGroups` unsupported in Safari)                                                                                              |
| Stylus                | `clngdbkpkpeebahjckkjfobafhncgmne` | `2.4.18`         | Verified        | Background & popup boot cleanly (empty `_execute_action` stripped; `permissions.contains`, `webNavigation`, `idle` shimmed)                                                     |
| Tampermonkey          | `dhdgffkkebhmkfjojejmpbldmpobfkfo` | `5.5.1`          | Unsupported API | Builds cleanly, but MV3 userscript execution requires `chrome.userScripts`, which Safari does not implement (warned up front)                                                   |
