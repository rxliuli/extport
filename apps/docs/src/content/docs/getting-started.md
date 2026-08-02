---
title: Getting started
description: Sign in, create your first extension, and pick your path — new project or existing one.
---

extport is currently in closed beta — new accounts are reviewed by hand. Sign in once and you'll either land in the
dashboard right away, or see a waiting screen until your account is activated. [Join the Discord](https://discord.gg/Va9kcSqu3f)
to reach us directly while you wait.

## 1. Sign in

Go to [dash.extport.dev](https://dash.extport.dev) and sign in with GitHub.

## 2. Create an extension

Click **Add** and give it a name. This is the thing you'll push versions to, sell licenses for, and see usage
analytics on — one extension can have a target configured for each of Chrome, Firefox, Edge, and Safari, and its
own licensing plans.

![The Extensions list with a "Redirector" extension added, showing empty Chrome/Firefox/Edge/Safari status columns](../../assets/screenshots/dashboard-extensions-list.png)

The name matters more than it looks: it's the identity your licensing plans verify against, so it freezes while
licensing is enabled. Pick the name your extension actually ships under.

## 3. Wire up your project

Two paths, depending on where you're starting from:

**Starting a new extension?** Let the scaffold do all of it:

```sh
npx extport login
npx extport init
```

`extport init` creates a [WXT](https://wxt.dev) project pre-wired with [`@extport/wxt`](https://www.npmjs.com/package/@extport/wxt),
bound to a real extension record from birth — including the GitHub Actions workflow that pushes to every store when
you bump the version. It can also create the extension record for you, so steps 2 and 3 collapse into one.

**Have an existing extension?** Add the id to your project so the CLI, SDK, and CI all resolve it without
hardcoding:

```ts
// wxt.config.ts (WXT projects — recommended)
export default defineConfig({
  modules: ['@extport/wxt'],
  extport: { extension: 'ext_…' }, // the id shown under your extension's name in the dashboard
})
```

Not on WXT? Create `extport.config.json` next to your `package.json` instead:

```json
{ "extension": "ext_…" }
```

## What's next

Each module is independent — adopt any of them, in any order:

- [Publishing](/publishing/) — add store credentials, connect store targets, and push your first build to every
  store from one command.
- [Licensing](/licensing/) — sell lifetime activation codes through your own Stripe Payment Link; extport fulfills
  and verifies them.
- [Analytics](/analytics/) — one anonymous ping per install per day, rolled up into weekly actives, installs, and
  version adoption across all four stores.
