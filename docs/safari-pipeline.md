# §8 — Safari publish pipeline (design)

Status: **design settled, not yet implemented** (2026-07-21). This is the
blueprint the `spec §8` comments in the code point at.

## The constraint that shapes everything

The App Store Connect REST API cannot upload a binary — building, signing,
and uploading require macOS (`xcodebuild`, `codesign`,
`notarytool`/Transporter). extport's server runs on Workers and never will
do this. Everything *after* a build exists in ASC — creating an
appStoreVersion, attaching the build, submitting for review, observing
state, withdrawing — is plain REST the server already speaks.

Proof both halves work: rxliuli/safari-webext-publish-action already ships
this exact split as two modes — a **build mode** that must run on a macOS
runner and a **submit mode** that runs on a *Linux* runner (i.e. pure REST).

## Division of labor

| Piece | Runs where | Does | Credentials |
|---|---|---|---|
| `extport` CLI (new macOS-only command) | tenant's Mac or macOS CI | `xcodebuild archive` → sign → package → upload binary to ASC. **Stops at upload — never submits for review.** | None handled by the CLI: signing resolves from the ambient keychain / Xcode automatic signing, upload auth from conventional locations (`~/private_keys`, env vars in CI). On CI, importing certs into the temp keychain stays the workflow's own setup step. |
| extport server (reconcile) | Workers | Observes ASC builds via API; when a `queued` safari version's build is processed, attaches it, sets metadata, submits for review — under the same queue semantics as every other store (blocked behind in-review, skip superseded, latest wins). | The ASC API key the tenant already stored in extport. |
| GitHub Action | macOS runner | Thin glue: import certs, invoke the CLI. The wrangler-action-wraps-wrangler model. | Repo secrets, as today. |

## Flow

1. Tenant pushes the web-extension zip to extport as usual → the safari
   target gets a `queued` deployment_versions row. The R2 zip is the
   *version intent record*; for safari the actual binary store is ASC
   itself.
2. Tenant's Mac/CI builds and uploads the binary (extport CLI command, or
   any existing pipeline — extport doesn't care how the build got there).
3. Next reconcile: a processed ASC build matching the queued version exists
   → attach + submit when the review slot is free. Status flows through the
   normal lifecycle (queued → in_review → online/rejected).

No "upload finished" notification is needed — the reconcile loop discovers
builds by observation, same as it discovers review outcomes.

## Platforms (iOS/macOS)

One ASC app spans both platforms with independent version timelines.
Platform is an **observed fact, not configuration**: still exactly one
`safari` target (one credential, one app id), but `deployment_versions`
gains a `platform` dimension and reconcile runs one lifecycle per platform
the app actually ships. The CLI builds/uploads both platform binaries in
one run (the action's build mode already auto-detects platforms from Xcode
schemes). The dashboard matrix grows `safari (macos)` / `safari (ios)`
columns. Until this lands, `getState()` deliberately tracks macOS only
(`filter[platform]=MAC_OS`) so mixed-platform responses can't flap.

## Boundaries deliberately kept out

- **Conversion (web extension → Xcode project) is not the CLI's job.**
  The action already assumes an existing project; project generation
  belongs to tools like wxt-module-safari-xcode or the tenant's own setup.
- **The CLI never submits for review.** Submission timing is the state
  machine's job; a CLI that submits would fork safari off the queue
  semantics every other store follows.
- **First-time app creation in ASC** can't be done via API — the tenant
  creates the App Store app record once by hand, same as today.

## Implementation notes

- The one seam that must be verified end-to-end: the queued version string
  must equal the uploaded build's `CFBundleShortVersionString` — version
  stamping is the conversion pipeline's responsibility.
- Replace `altool` with `notarytool`/Transporter while absorbing the
  action's build mode (altool upload is deprecated by Apple).
- Migration for the author's own extensions: the action's submit mode is
  deleted outright (reconcile replaces it, and adds queue/blocked/skip,
  stale-review notifications, and the Timeline — which the action never
  had); build mode shrinks to setup + CLI invocation.
