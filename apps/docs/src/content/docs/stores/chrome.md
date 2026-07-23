---
title: Chrome
description: Chrome Web Store credentials and store item id.
---

extport publishes to the Chrome Web Store using a Google Cloud **service account** and the Chrome Web Store
Publish API — the same mechanism `chrome-webstore-upload` and similar CI tools use, not your personal Google login.

## Credential fields

Under **Settings → Store credentials → Chrome**, extport asks for:

| Field | Where it comes from |
| --- | --- |
| Publisher ID | Chrome Web Store Developer Dashboard → Account |
| Service Account Email | The `client_email` field in your service account's downloaded JSON key |
| Service Account Private Key | The `private_key` field in the same JSON key |

To create the service account: in Google Cloud Console, enable the **Chrome Web Store API** for your project,
create a service account, generate a JSON key for it, then grant that service account access from the Chrome Web
Store Developer Dashboard's account settings.

:::note[Screenshot pending]
Chromium hard-blocks browser-extension automation on `chrome.google.com/webstore/*` ("The extensions gallery
cannot be scripted"), so this one has to be captured by hand:

1. Open the [Developer Dashboard](https://chromewebstore.google.com/devconsole) → **Account**.
2. Screenshot the panel showing the **Publisher ID**.
3. Redact/crop out your account email and anything from other, unrelated extensions in the same account before
   saving.
4. Save as `apps/docs/src/assets/screenshots/chrome-publisher-id.png` and reference it here with
   `![Publisher ID in the Chrome Web Store Developer Dashboard](../../../assets/screenshots/chrome-publisher-id.png)`.
:::

## Store item id

When adding a Chrome target on an extension, the **store item id** is the id in your item's Developer Dashboard URL
(`chromewebstore.google.com/detail/.../<item-id>`) or the store listing URL — a 32-character lowercase string.

## Notes

- The Chrome Web Store API applies its own review process independent of extport — extport only submits, it can't
  speed up or bypass review.
- Uploading a new version does not publish it automatically to all trusted testers/rollout groups; that behavior is
  controlled by your existing Chrome Web Store publish settings, not by extport.
