---
title: Firefox
description: Firefox Add-ons (AMO) credentials and add-on id.
---

extport publishes to Firefox Add-ons (AMO) using its JWT-based Add-on API — the same credentials the `web-ext sign`
CLI and AMO's own API docs use.

## Credential fields

Under **Settings → Store credentials → Firefox**, extport asks for:

| Field | Where it comes from |
| --- | --- |
| JWT Issuer | addons.mozilla.org → Developer Hub → Manage API Keys → "JWT issuer" |
| JWT Secret | The same page, shown once when the key is generated |

If you don't already have API keys, generate a new key pair from the Developer Hub — regenerating invalidates the
previous secret, so rotate the credential in extport's Settings right after.

![The Manage API Keys page in the AMO Developer Hub, showing the JWT issuer and JWT secret fields](../../../assets/screenshots/firefox-api-keys.png)

## Store item id

The **store item id** is your add-on's id or slug, found in its AMO listing URL
(`addons.mozilla.org/.../addon/<slug>/`) or in the Developer Hub's "Manage" page for that add-on.

## Source zip

AMO requires the original, unminified source alongside a minified/bundled submission. When pushing specifically to
Firefox (`--store firefox` / a Firefox-targeted push), you can attach a source zip alongside the build —
see [Getting started](/getting-started/) for the push command shape.
