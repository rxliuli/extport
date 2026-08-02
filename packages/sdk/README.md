# @extport/sdk

License activation and anonymous usage analytics for browser extensions publishing through [extport](https://extport.dev) — sell lifetime licenses through your own Stripe Payment Link and see active users across Chrome, Firefox, Edge, and Safari in one dashboard.

The server is the only source of truth: activations verify online and cache the resulting entitlement locally. There is deliberately no client-side cryptography to reverse-engineer.

## Install

```sh
pnpm add @extport/sdk
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
// Redeem a code the buyer received by email
await activationClient.activate('XXXX-XXXX-XXXX-XXXX')

// Gate a feature — always reads current persisted state
const plan = await activationClient.getPlan()
if (count > plan.limit.records) showUpgradePrompt()

// Periodic heartbeat + self-healing re-activation (call from the background)
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

Guide: [docs.extport.dev/licensing](https://docs.extport.dev/licensing/)

## Analytics

One anonymous ping per install per day — a random install id, version, and browser UI language; browser, OS, and country derive server-side from the request. No URLs, no page content, no behavioral data.

```ts
// entrypoints/background.ts
import { attachAnalytics } from '@extport/sdk/analytics'

attachAnalytics() // extensionId auto-resolves via @extport/wxt, or pass { extensionId: 'ext_…' }
```

With `@extport/wxt` this is a single config flag (`analytics: true`) instead. Firefox's built-in data-collection consent (`technicalAndInteraction`) is respected automatically. A provider for [`@wxt-dev/analytics`](https://www.npmjs.com/package/@wxt-dev/analytics) ships as `@extport/sdk/wxt-analytics`.

Guide: [docs.extport.dev/analytics](https://docs.extport.dev/analytics/)

## License

MIT
