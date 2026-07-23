---
title: Getting started
description: Sign in, get an API key, and push your first build.
---

extport is currently in closed beta — new accounts are reviewed by hand. Sign in once and you'll either land in the
dashboard right away, or see a waiting screen until your account is activated. [Join the Discord](https://discord.gg/Va9kcSqu3f)
to reach us directly while you wait.

## 1. Sign in

Go to [dash.extport.dev](https://dash.extport.dev) and sign in with GitHub.

## 2. Create an extension

From the dashboard, click **Add** and give it a name. This is the thing you'll push versions to — one extension can
have a target configured for each of Chrome, Firefox, Edge, and Safari.

## 3. Add your store credentials

Under **Settings → Store credentials**, add a credential for each store you publish to. See the per-store pages for
exactly which fields you need and where to find them:

- [Chrome](/stores/chrome/)
- [Firefox](/stores/firefox/)
- [Edge](/stores/edge/)
- [Safari](/stores/safari/)

## 4. Connect a store target

Open your extension, and under **Targets** add one per store — this is where the store's own listing id and your
credential get linked together.

## 5. Get an API key

Under **Settings → API keys**, create a key. This is what the CLI and GitHub Actions use to push on your behalf —
treat it like a password.

## 6. Push a build

Either from your own machine:

```sh
npx extport login
npx extport push dist/my-extension.zip --extension my-extension --version 1.0.0
```

Or from CI, using the published GitHub Actions:

```yaml
- uses: extport-dev/actions/push@v1
  with:
    api-key: ${{ secrets.EXTPORT_API_KEY }}
    extension: my-extension
    zip-path: dist/my-extension.zip
```

Omit `--store`/`store:` to push a universal zip to every store target you've configured for that extension, or
target one store specifically (e.g. for Firefox's separate source-zip requirement). Safari has no zip upload at
all — it's built and signed locally via `extport safari-build`, see the [Safari](/stores/safari/) page.
