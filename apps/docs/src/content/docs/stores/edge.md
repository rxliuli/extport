---
title: Edge
description: Edge Add-ons (Partner Center) credentials, product id, and crx id.
---

extport publishes to Edge Add-ons using Partner Center's Submission API.

## Credential fields

Under **Settings → Store credentials → Edge**, extport asks for:

| Field | Where it comes from |
| --- | --- |
| Client ID | Partner Center → Publish API access → Client ID |
| API Key | Partner Center → Publish API access → API key (client secret) |

Generate these from your Partner Center account's API access settings — a single client id/key pair can cover every
extension on that account.

## Product id and crx id

Edge is the one store with two different ids for the same listing:

| Field | Used for | Where it comes from |
| --- | --- | --- |
| Product ID | Required — the Submission API's internal GUID | Partner Center → your extension → Extension identity |
| CRX ID | Optional | The store-facing id shown on the extension's public Edge Add-ons page |

Product ID is what actually publishes; CRX ID only helps extport detect the live version between reconcile ticks
when the Submission API itself can't report status.
