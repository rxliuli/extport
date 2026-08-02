# @extport/cli

Command-line client for [extport](https://extport.dev) — scaffold a browser extension wired for Chrome, Firefox, Edge, and Safari, and push builds to every store from one command.

## Install

```sh
npx extport login   # authorize this machine via your browser
```

No global install needed — `npx extport` (or `pnpm dlx extport`) resolves the `extport` bin from this package.

## Commands

| Command | What it does |
| --- | --- |
| `extport login` / `logout` / `whoami` | Browser-based device authorization; credentials stored locally |
| `extport init` | Scaffold a new extension project (WXT + `@extport/wxt`), bound to a real extport extension record from birth |
| `extport push` | Upload a zip and publish it to configured stores — version inferred from the manifest, store targets from `extport.config.json` |
| `extport safari-build` | Build, sign, and upload the Safari/Xcode target to App Store Connect (runs on your machine or CI — your Apple credentials never touch extport) |

```sh
# Push the WXT build output to every configured store
npx extport push

# Or one store, one file, explicitly
npx extport push --store chrome --file .output/my-extension-1.2.3-chrome.zip
```

In CI, use [extport-dev/actions](https://github.com/extport-dev/actions) — same operations as GitHub Actions steps, with the version-change detection and store submission wired up.

Docs: [docs.extport.dev](https://docs.extport.dev)

## License

MIT
