---
title: Safari
description: App Store Connect credentials, the Admin-role requirement, and how Safari's push differs from every other store.
---

Safari is the odd one out: there's no zip upload through extport at all. The build itself is compiled, code-signed,
and uploaded straight to App Store Connect from your own machine (or CI runner) via `extport safari-build` — extport
only tracks version/review status afterward.

## Credential fields

Under **Settings → Store credentials → Safari**, extport asks for:

| Field | Where it comes from |
| --- | --- |
| Key ID | [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api) → your key's "KEY ID" column |
| Issuer ID | Same page, shown above the key list as "Issuer ID" |
| .p8 Private Key | Downloaded once when the key is created — App Store Connect never lets you re-download it |

![The App Store Connect API page under Users and Access → Integrations, showing Issuer ID and the Active keys table with its Access column](../../../assets/screenshots/safari-asc-api-keys.png)

### The key's role must be Admin

This is the part that isn't obvious from Apple's own docs: cloud code signing (`xcodebuild -allowProvisioningUpdates`,
which is what `extport safari-build` uses) needs an API key with the **Admin** role specifically — the "Access"
column in the screenshot above. Developer or App Manager roles can authenticate fine but fail partway through
signing with a "Cloud signing permission error" — confirmed against Apple's real API, not just the docs. If you hit
that error, generate a new key with the Admin role and rotate the credential in both extport's Settings and your CI
secrets.

## Store item id

The Safari **store item id** is your app's Apple ID (the numeric App Store Connect app id), not the bundle id.

For example, [Redirector](https://store.rxliuli.com/extensions/redirector/)'s iOS app is at
`apps.apple.com/app/url-redirector/id6743197230` — the trailing `6743197230` is the store item id.

## Building and uploading

`extport safari-build` needs your Xcode project path and Apple Developer Team ID in addition to the API key —
either passed as flags/env vars, or saved once via `extport init`'s interactive Safari setup into
`extport.config.json`:

```sh
npx extport safari-build --project-path ./ios --team-id ABCDE12345
```

Or from CI:

```yaml
- uses: extport-dev/actions/safari-build@v1
  with:
    issuer-id: ${{ secrets.APPLE_API_ISSUER }}
    key-id: ${{ secrets.APPLE_API_KEY_ID }}
    key-base64: ${{ secrets.APPLE_API_KEY }}
    project-path: ./ios
    team-id: ABCDE12345
```

This builds and uploads every platform your Xcode project ships (macOS and/or iOS) — Safari's macOS and iOS
listings run fully independent review timelines under the same App Store Connect app.
