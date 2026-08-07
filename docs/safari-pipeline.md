# §8 — Safari publish pipeline (design)

Status: **implemented and verified end-to-end** (2026-07-21), both phases,
against the real Scrub app. Phase A: server-side platform dimension + ASC
review-submission orchestration, verified by a real reconcile that
submitted macOS and iOS v0.0.7 for Apple review. Phase B: `extport
safari-build` built, signed, and uploaded real macOS and iOS v0.0.8
binaries in one run each — confirmed independently via the ASC `/v1/builds`
API (both `processingState: VALID`), not just the CLI's own reported
success.

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
| GitHub Action | macOS runner | Thin glue: import a certificate, invoke the CLI. The wrangler-action-wraps-wrangler model. | Repo secrets, as today. |

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
has a `platform` dimension and reconcile runs one lifecycle per platform
the app actually ships. The CLI builds/uploads both platform binaries in
one run (the action's build mode auto-detects platforms from Xcode
schemes). The dashboard matrix has `safari (macos)` / `safari (ios)`
columns. **Shipped** — `getState()` requires an explicit platform and
queries each independently (`filter[platform]=MAC_OS` / `IOS`), so the
two never flap into each other.

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
  stamping is the conversion pipeline's responsibility. `extport safari-build
  --version x.y.z` is a safety net, not an owner of this: it reads the built
  app's actual version after archiving and fails loudly on a mismatch,
  before ever attempting an export/upload.
- **Not `notarytool`/Transporter as originally guessed** — research turned
  up a better fit: `xcodebuild -exportArchive` with `destination: upload` in
  the export options plist is Apple's own current replacement for altool's
  upload step (confirmed against Apple's docs, 2026). Combined with
  automatic signing (`CODE_SIGN_STYLE=Automatic` + `-allowProvisioningUpdates`
  + an ASC API key), one `xcodebuild archive` and one `xcodebuild
  -exportArchive` per platform does the entire build → sign → package →
  upload — no manual `codesign`/`productbuild`, no certificate or
  provisioning-profile files, no signing-identity strings for the tenant to
  supply. This is a deliberate departure from the action's approach (manual
  codesign of the app + nested `.appex`, then `productbuild`, then
  `altool --upload-app`), which exists because CI runners start with no
  keychain state at all and need explicit cert/profile import; a tenant's
  own Mac (or a CI runner that already did that import) doesn't need any of
  that ceremony. **Verified**: a real run against Scrub's project (macOS +
  iOS, each independently) succeeded on the first try — automatic signing
  resolved the nested Safari extension `.appex` correctly, no manual
  codesign step needed.
- Migration for the author's own extensions: the action's submit mode is
  deleted outright (reconcile replaces it, and adds queue/blocked/skip,
  stale-review notifications, and the Timeline — which the action never
  had); build mode shrinks to setup + CLI invocation (`extport safari-build`).
- **"No certificate files to supply" has a real cost on CI that surfaced in
  production**, not just theoretically: a GitHub-hosted macOS runner starts
  with an empty keychain every run, so `-allowProvisioningUpdates` finds no
  local signing identity and asks Apple to mint a brand new one each time.
  That certificate's private key dies with the runner at the end of the
  job — permanently unusable from that point on — so every run without a
  reused certificate silently burns one for good, until the account hits
  Apple's cap on how many of that type it allows. Confirmed against
  `rxliuli/twitter-exporter`'s real CI, which had been doing exactly this
  for days before failing outright with "Your account has reached the
  maximum number of certificates." Fixed at the GitHub Action layer, not the
  CLI's — matching the division of labor above, `extport-dev/actions`'
  `safari-build` action now has optional `certificate-base64`/
  `certificate-password` inputs that import one certificate (generated once,
  reused every run — it's tied to the Apple Developer account, not to any
  one app) into a temporary keychain before invoking the CLI. The CLI itself
  didn't change: automatic signing already reuses whatever identity it finds
  in the local keychain, so importing one ahead of time was the entire fix.
