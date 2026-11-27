# @extport/sdk

License activation and anonymous usage analytics for browser extensions publishing through [extport](https://extport.dev) — sell one-time licenses or recurring subscriptions through your connected Stripe account, and see active users across Chrome, Firefox, Edge, and Safari in one dashboard.

The server is the only source of truth: activations verify online and cache the resulting entitlement locally (`browser.storage.local` by default, with automatic migration from legacy `idb-keyval`). There is deliberately no client-side cryptography to reverse-engineer.

## Install

```sh
pnpm add @extport/sdk
```

With [WXT](https://wxt.dev) (recommended), pair `@extport/sdk` with [`@extport/wxt`](https://www.npmjs.com/package/@extport/wxt) so `extensionId` injects automatically and your manifest includes the required `storage` permission:

```ts
// wxt.config.ts
export default defineConfig({
  modules: ['@extport/wxt'],
  manifest: {
    permissions: ['storage'],
  },
  extport: {
    extension: 'ext_…',
    analytics: true,
  },
})
```

## Licensing

```ts
// lib/activation.ts — shared by every context
import { createActivationClient } from '@extport/sdk'
import { webextTransport } from '@extport/sdk/webext'

interface PlanLimit {
  records: number
}

const plans: Record<'free' | 'pro', PlanLimit> = {
  free: { records: 100 },
  pro: { records: Number.MAX_SAFE_INTEGER },
}

export const activationClient = createActivationClient<'free' | 'pro', PlanLimit>({
  plans,
  transport: webextTransport(),
})
```

`extensionId` resolves automatically when the extension is built with [`@extport/wxt`](https://www.npmjs.com/package/@extport/wxt) (`extport: { extension: 'ext_…' }`); otherwise pass it explicitly.

```ts
// entrypoints/background.ts — sync across contexts and re-verify on startup
import { attachBackground } from '@extport/sdk/webext'
import { activationClient } from '../lib/activation'

export default defineBackground(() => {
  attachBackground(activationClient)
})
```

```ts
// Redeem an activation code from checkout / email
await activationClient.activate('XXXX-XXXX-XXXX-XXXX')

// Gate a feature — always reads current persisted state
const plan = await activationClient.getPlan()
if (count > plan.limit.records) showUpgradePrompt()

// Manual heartbeat + self-healing re-activation (attachBackground handles this automatically)
await activationClient.checkActivation()
```

React rendering layer:

```tsx
import { usePlan } from '@extport/sdk/react'

function Paywall() {
  const plan = usePlan(activationClient)
  return plan.tier === 'pro' ? <ProBadge /> : <UpgradeButton />
}
```

> **Storage & migration:** `@extport/sdk` stores activation state in `browser.storage.local` (`extport-plan`) when available, so it works reliably across MV3 service workers, popups, options pages, and content scripts (requires the `storage` permission in `manifest.json`). Existing installs from older SDK versions are migrated lazily from `idb-keyval` on first read.

Guide: [docs.extport.dev/licensing](https://docs.extport.dev/licensing/)

## Analytics

One anonymous ping per install per day — a random install id, version, and browser UI language; browser, OS, and country derive server-side from the request. No URLs, no page content, no behavioral data.

With `@extport/wxt` (recommended), enable it with one config flag (`analytics: true` in `wxt.config.ts`). Without WXT, call `attachAnalytics` from your background entrypoint:

```ts
// entrypoints/background.ts
import { attachAnalytics } from '@extport/sdk/analytics'

attachAnalytics({ extensionId: 'ext_…' })
```

Firefox's built-in data-collection consent (`technicalAndInteraction`) is respected automatically. If you already use [`@wxt-dev/analytics`](https://wxt.dev/analytics.html#extport), extport is built in as `@wxt-dev/analytics/providers/extport`.

Guide: [docs.extport.dev/analytics](https://docs.extport.dev/analytics/)

## Subpath exports

- `@extport/sdk` — `createActivationClient`, `ActivationClient`, `resolveExtensionId`, `idbStorage`, and core types
- `@extport/sdk/webext` — `webextTransport`, `attachBackground`
- `@extport/sdk/react` — `usePlan`
- `@extport/sdk/analytics` — `attachAnalytics`, `createAnalyticsPinger`
- `@extport/sdk/wxt-analytics` — compatibility adapter for older versions of `@wxt-dev/analytics` (prefer WXT's built-in `@wxt-dev/analytics/providers/extport`)

## License

MIT
