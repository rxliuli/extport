# @extport/cli

Command-line client for [extport](https://extport.dev) — scaffold a WXT browser extension wired for Chrome, Firefox, Edge, and Safari, and push builds to every store from one command.

## Install

```sh
npx @extport/cli login   # authorize this machine via your browser
```

No global install needed — `npx @extport/cli` (or `pnpm dlx @extport/cli`) runs the `extport` bin from this package (or install globally with `npm i -g @extport/cli` to invoke `extport` directly). Check the installed version with `npx @extport/cli --version`.

## Commands

| Command | What it does |
| --- | --- |
| `extport login` / `logout` / `whoami` | Browser-based device authorization; credentials stored locally (bound to the API origin) |
| `extport init` | Scaffold a new WXT extension project (`@extport/wxt`), bound to a real extport extension record from birth |
| `extport push [file]` | Upload a zip and publish it to configured stores — file, version, and source zip inferred automatically in WXT projects |
| `extport safari-build` | Build, sign, and upload the Safari/Xcode target to App Store Connect (runs on your machine or CI — your Apple credentials never touch extport) |
| `extport port safari <source>` | Convert any MV3 Chrome extension (CWS URL/ID, `.crx`, `.zip`, or folder), sign with an optional local Keychain certificate, and install locally on macOS or iOS |
| `extport completion [shell]` | Print a Tab-completion script for `bash`, `zsh`, or `fish` |

```sh
# WXT project (recommended): push build outputs to every configured store
npx @extport/cli push

# Or push a single store/file explicitly (file is a positional argument)
npx @extport/cli push .output/my-extension-1.2.3-firefox.zip --store firefox
```

In CI, use [extport-dev/actions](https://github.com/extport-dev/actions) — same operations as GitHub Actions steps, with version-change detection and store submission wired up.

Docs: [docs.extport.dev](https://docs.extport.dev)

## License

MIT
