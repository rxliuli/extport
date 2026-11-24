# @extport/wxt

[WXT](https://wxt.dev) module for extensions publishing through [extport](https://extport.dev): one config block wires up store publishing metadata, license/analytics identity injection, manifest permission checks, and Safari's Xcode project generation.

## Install

```sh
pnpm add -D @extport/wxt
pnpm add @extport/sdk   # needed if you enable analytics or licensing
```

```ts
// wxt.config.ts
export default defineConfig({
  modules: ['@extport/wxt'],
  manifest: {
    permissions: ['storage'], // required when extport.extension is set
  },
  extport: {
    extension: 'ext_…', // your extension's extport id
    analytics: true, // optional: daily anonymous usage ping
    safari: {
      // optional: build a Safari App Store target
      appCategory: 'public.app-category.productivity',
      bundleIdentifier: 'com.example.my-extension',
      developmentTeam: 'ABCDE12345',
    },
  },
})
```

## What it does

- **`extension`** — syncs the id into `extport.config.json` (the static file [`extport` CLI](https://www.npmjs.com/package/@extport/cli) and [extport-dev/actions](https://github.com/extport-dev/actions) read), injects `globalThis.__EXTPORT__.extensionId` into every entrypoint so [`@extport/sdk`](https://www.npmjs.com/package/@extport/sdk) resolves identity with zero hardcoding, and verifies at build time that `manifest.permissions` includes `'storage'` (used by `@extport/sdk` for both licensing and analytics).
- **`analytics: true`** — attaches the daily ping to your background entrypoint and adds Firefox's `data_collection_permissions` (`technicalAndInteraction`) declaration to the manifest. Explicit opt-in; nothing is collected without it. Requires `@extport/sdk` as a dependency.
- **`safari: { … }`** — on `wxt build -b safari` / `wxt zip -b safari`, converts the build output into a signed-ready Xcode project (`projectType`: `'macos' | 'ios' | 'both'`, default `'both'`, with a built-in setup page for macOS, iOS, and iPadOS) for [`extport safari-build`](https://docs.extport.dev/stores/safari/) to compile and upload.

## Requirements

`wxt` is a peer dependency (`>=0.20`). The 0.20.x line is what the module is battle-tested against; wxt 0.21.x currently ships an experimental Vite 8/Rolldown pipeline with known build issues independent of this module.

Docs: [docs.extport.dev](https://docs.extport.dev)

## License

MIT
