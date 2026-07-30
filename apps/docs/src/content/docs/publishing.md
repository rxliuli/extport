---
title: Publishing
description: Add store credentials, connect a target, and push your first build.
---

Once you've [signed in and created an extension](/getting-started/), connect it to the stores you publish to and
push a build.

The examples on this page and the store pages all use one real, published extension — [Redirector](https://store.rxliuli.com/extensions/redirector/),
which ships on all four stores — so every id shown is something you can look up yourself, not a placeholder.

## 1. Add your store credentials

Under [**Settings → Store credentials**](https://dash.extport.dev/settings#store-credentials), add a credential for each store you publish to. Each row shows the store,
a label, the last four characters of the credential, and whether it verified successfully:

![The Store credentials list, showing one row each for Safari, Edge, Firefox, and Chrome with their status](../../assets/screenshots/dashboard-store-credentials.png)

See the per-store pages for exactly which fields you need and where to find them:

- [Chrome](/stores/chrome/)
- [Firefox](/stores/firefox/)
- [Edge](/stores/edge/)
- [Safari](/stores/safari/)

## 2. Connect a store target

Open your extension and click **Add a store**. This is where the store's own listing id and one of your credentials
get linked together — for Redirector on Chrome, that's its real item id, `lioaeidejmlpffbndjhaameocfldlhin`
(from its [Chrome Web Store listing](https://chromewebstore.google.com/detail/redirector/lioaeidejmlpffbndjhaameocfldlhin)):

![The "Add a store" dialog for the Redirector extension, with Chrome selected and its real Chrome Web Store item id filled in](../../assets/screenshots/dashboard-add-store-target.png)

## 3. Get an API key

Under [**Settings → API keys**](https://dash.extport.dev/settings#api-keys), name a key and click **Create**. The full value is shown exactly once — copy it
immediately, since only the last four characters are shown afterward:

![The API keys panel right after creating a key named "ci", showing the full sk_live_… value in a "copy now — shown once" banner](../../assets/screenshots/dashboard-api-keys.png)

This is what the CLI and GitHub Actions use to push on your behalf — treat it like a password.

## 4. Push a build

Either from your own machine:

```sh
npx extport login
npx extport push dist/my-extension.zip --extension ext_yourExtensionId --version 1.0.0
```

Or from CI, using the published GitHub Actions:

```yaml
- uses: extport-dev/actions/push@v1
  with:
    api-key: ${{ secrets.EXTPORT_API_KEY }}
    extension: ext_yourExtensionId
    file: dist/my-extension.zip
```

Both `extension` and `file` can be omitted: the extension id comes from `extport.config.json`, and in a WXT
project the zip and version are inferred from `.output/` and its `manifest.json`.

Omit `--store`/`store:` to push a universal zip to every store target you've configured for that extension, or
target one store specifically (e.g. for Firefox's separate source-zip requirement). Safari has no zip upload at
all — it's built and signed locally via `extport safari-build`, see the [Safari](/stores/safari/) page.

Every push is checked against its target stores before it's accepted: a zip without a `manifest.json`, a manifest
version that doesn't match the pushed version, a Chrome-only build (no `gecko.id`, service-worker-only background)
headed for Firefox, or Manifest V2 headed for Chrome all fail immediately with the reason — not days later in
store review.

## Shell completion

`extport completion bash|zsh|fish` prints a Tab-completion script for subcommands, flag names, and the values of
`--store`/`--platform`. It only prints — add the right line to your shell's own config to make it stick, same as
`gh`/`kubectl`/`rustup`:

```sh
# ~/.zshrc
eval "$(extport completion zsh)"

# ~/.bashrc
eval "$(extport completion bash)"

# ~/.config/fish/config.fish
extport completion fish | source
```

Open a new terminal (or `source` the file you just edited) to pick it up. The shell name is optional — omit it
(`extport completion`) and it detects the one you're currently running.
