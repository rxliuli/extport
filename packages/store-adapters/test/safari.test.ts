import { describe, expect, it } from 'vitest'
import { createSafariAdapter } from '../src/safari'
import { queueFetch, unreachableFetch } from './fetch-stub'

const APP_ID = 'app-123'
const FAST_RETRY = { attempts: 3, baseDelayMs: 1 }

async function makeP8(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  let binary = ''
  for (const b of pkcs8) binary += String.fromCharCode(b)
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`
}

async function creds() {
  return { keyId: 'KEY1', issuerId: 'iss-1', privateKeyP8: await makeP8() }
}

function version(versionString: string, appVersionState: string) {
  return { attributes: { versionString, appVersionState } }
}

describe('safari adapter — getState', () => {
  it('picks the live version and a pending-review version separately', async () => {
    const { fetch, calls } = queueFetch([
      {
        status: 200,
        body: { data: [version('1.1.0', 'WAITING_FOR_REVIEW'), version('1.0.0', 'READY_FOR_DISTRIBUTION')] },
      },
    ])
    const state = await createSafariAdapter(fetch).getState(await creds(), { storeItemId: APP_ID })
    expect(state).toEqual({ live: { known: true, version: '1.0.0' }, inReview: { known: true, version: '1.1.0' }, reviewStatus: 'pending', rejectionReason: undefined })
    expect(calls[0]!.url).toContain(`/v1/apps/${APP_ID}/appStoreVersions`)
    // One ASC app spans macOS + iOS with independent version timelines —
    // every query is platform-scoped so mixed-platform responses can't flap.
    expect(calls[0]!.url).toContain('filter[platform]=MAC_OS')
  })

  it('maps the ios platform to ASC\'s IOS filter', async () => {
    const { fetch, calls } = queueFetch([{ status: 200, body: { data: [] } }])
    await createSafariAdapter(fetch).getState(await creds(), { storeItemId: APP_ID }, 'ios')
    expect(calls[0]!.url).toContain('filter[platform]=IOS')
  })

  it('reports a rejected version with a pointer to Activity, not a fabricated reason', async () => {
    const { fetch } = queueFetch([
      { status: 200, body: { data: [version('1.1.0', 'REJECTED'), version('1.0.0', 'READY_FOR_DISTRIBUTION')] } },
    ])
    const state = await createSafariAdapter(fetch).getState(await creds(), { storeItemId: APP_ID })
    expect(state.reviewStatus).toBe('rejected')
    expect(state.rejectionReason).toMatch(/App Store Connect/)
  })

  it('handles an app with no versions at all', async () => {
    const { fetch } = queueFetch([{ status: 200, body: { data: [] } }])
    const state = await createSafariAdapter(fetch).getState(await creds(), { storeItemId: APP_ID })
    expect(state).toEqual({ live: { known: true }, inReview: { known: true }, reviewStatus: undefined, rejectionReason: undefined })
  })

  it('throws on a lookup failure that outlasts the retry budget', async () => {
    const { fetch, calls } = queueFetch([{ status: 500, body: 'oops' }])
    await expect(createSafariAdapter(fetch, FAST_RETRY).getState(await creds(), { storeItemId: APP_ID })).rejects.toThrow(/versions lookup failed/)
    expect(calls).toHaveLength(FAST_RETRY.attempts)
  })

  it('retries a transient 5xx and succeeds once the store recovers', async () => {
    const { fetch, calls } = queueFetch([
      { status: 500, body: 'oops' },
      { status: 200, body: { data: [version('1.0.0', 'READY_FOR_DISTRIBUTION')] } },
    ])
    const state = await createSafariAdapter(fetch, FAST_RETRY).getState(await creds(), { storeItemId: APP_ID })
    expect(state.live).toEqual({ known: true, version: '1.0.0' })
    expect(calls).toHaveLength(2)
  })

  it('never retries a 4xx', async () => {
    const { fetch, calls } = queueFetch([{ status: 404, body: 'not found' }])
    await expect(createSafariAdapter(fetch, FAST_RETRY).getState(await creds(), { storeItemId: APP_ID })).rejects.toThrow(/versions lookup failed/)
    expect(calls).toHaveLength(1)
  })

  it('does not report a PREPARE_FOR_SUBMISSION draft as in review — it is an editable draft, not a genuine Apple review', async () => {
    // Also asserts the filter query never asks ASC for this state at all —
    // treating it as "nothing happening" requires excluding it up front,
    // not just ignoring it after the fact.
    const { fetch, calls } = queueFetch([
      { status: 200, body: { data: [version('1.1.0', 'PREPARE_FOR_SUBMISSION'), version('1.0.0', 'READY_FOR_DISTRIBUTION')] } },
    ])
    const state = await createSafariAdapter(fetch).getState(await creds(), { storeItemId: APP_ID })
    expect(state).toEqual({ live: { known: true, version: '1.0.0' }, inReview: { known: true, version: undefined }, reviewStatus: undefined, rejectionReason: undefined })
    expect(calls[0]!.url).not.toContain('PREPARE_FOR_SUBMISSION')
  })

  it('does not report a READY_FOR_REVIEW version as in review — the submission has not been confirmed yet', async () => {
    // The state a submit() that died between build-attach and the final
    // confirm leaves behind (Twitter Filter macOS v0.0.66, 2026-08-13).
    // Reporting it as in-review deadlocks the queued row: decide() waits
    // forever for a review Apple was never asked to start.
    const { fetch, calls } = queueFetch([
      { status: 200, body: { data: [version('1.1.0', 'READY_FOR_REVIEW'), version('1.0.0', 'READY_FOR_DISTRIBUTION')] } },
    ])
    const state = await createSafariAdapter(fetch).getState(await creds(), { storeItemId: APP_ID })
    expect(state).toEqual({ live: { known: true, version: '1.0.0' }, inReview: { known: true, version: undefined }, reviewStatus: undefined, rejectionReason: undefined })
    expect(calls[0]!.url).not.toContain('READY_FOR_REVIEW')
  })
})

describe('safari adapter — withdraw', () => {
  it('cancels the in-flight review submission', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { data: [{ id: 'sub-1' }] } },
      { status: 200, body: {} },
    ])
    await createSafariAdapter(fetch).withdraw!(await creds(), { storeItemId: APP_ID })
    expect(calls[1]!.url).toBe('https://api.appstoreconnect.apple.com/v1/reviewSubmissions/sub-1')
    expect(calls[1]!.init?.method).toBe('PATCH')
    const body = JSON.parse(String(calls[1]!.init?.body))
    expect(body.data.attributes.canceled).toBe(true)
  })

  it('is a no-op when nothing is in review', async () => {
    const { fetch, calls } = queueFetch([{ status: 200, body: { data: [] } }])
    await createSafariAdapter(fetch).withdraw!(await creds(), { storeItemId: APP_ID })
    expect(calls).toHaveLength(1)
  })

  it('throws if the cancel patch fails', async () => {
    const { fetch } = queueFetch([{ status: 200, body: { data: [{ id: 'sub-1' }] } }, { status: 409, body: 'conflict' }])
    await expect(createSafariAdapter(fetch).withdraw!(await creds(), { storeItemId: APP_ID })).rejects.toThrow(/cancel failed/)
  })
})

describe('safari adapter — submit (review orchestration, binary uploaded out-of-band)', () => {
  const zip = new ArrayBuffer(8)

  it('waits (not an error) until a processed build for the version appears in ASC', async () => {
    const { fetch, calls } = queueFetch([{ status: 200, body: { data: [] } }])
    const result = await createSafariAdapter(fetch).submit(await creds(), { storeItemId: APP_ID }, zip, '1.2.0', 'macos')
    expect(result.submitted).toBe(false)
    expect(result.waiting).toBe(true)
    expect(result.detail).toMatch(/waiting for a processed macos build/)
    expect(calls[0]!.url).toContain('/v1/builds?')
    expect(calls[0]!.url).toContain('filter[preReleaseVersion.version]=1.2.0')
    expect(calls[0]!.url).toContain('filter[preReleaseVersion.platform]=MAC_OS')
    expect(calls[0]!.url).toContain('filter[processingState]=VALID')
  })

  it('runs the full flow: build → create version → attach → release notes → create submission → add item → submit', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { data: [{ id: 'build-1' }] } }, // builds lookup
      { status: 200, body: { data: [] } }, // version lookup — none yet
      { status: 201, body: { data: { id: 'ver-1' } } }, // create version
      { status: 200, body: {} }, // attach build
      { status: 200, body: { data: [{ id: 'loc-1', attributes: { whatsNew: null } }] } }, // localizations — empty notes
      { status: 200, body: {} }, // PATCH whatsNew
      { status: 200, body: { data: [] } }, // open submissions — none
      { status: 201, body: { data: { id: 'sub-1' } } }, // create submission
      { status: 200, body: { data: [] } }, // items lookup — empty
      { status: 201, body: {} }, // add item
      { status: 200, body: {} }, // PATCH submitted:true
    ])
    const result = await createSafariAdapter(fetch).submit(await creds(), { storeItemId: APP_ID }, zip, '1.2.0', 'ios')
    expect(result).toMatchObject({ submitted: true })
    expect(result.detail).toMatch(/submitted ios v1.2.0/)

    // The version lookup asks for the platform's one editable slot, not a
    // versionString match — an occupied slot under another number must be
    // found (and renamed), never created around.
    expect(calls[1]!.url).toContain(`/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&filter[appVersionState]=`)
    expect(calls[1]!.url).toContain('PREPARE_FOR_SUBMISSION')
    expect(calls[1]!.url).not.toContain('filter[versionString]')
    const createVersion = JSON.parse(String(calls[2]!.init?.body))
    expect(createVersion.data.attributes).toEqual({ platform: 'IOS', versionString: '1.2.0' })
    expect(calls[3]!.url).toBe('https://api.appstoreconnect.apple.com/v1/appStoreVersions/ver-1/relationships/build')
    expect(JSON.parse(String(calls[3]!.init?.body)).data.id).toBe('build-1')
    expect(calls[4]!.url).toContain('/v1/appStoreVersions/ver-1/appStoreVersionLocalizations')
    const notes = JSON.parse(String(calls[5]!.init?.body))
    expect(calls[5]!.url).toContain('/v1/appStoreVersionLocalizations/loc-1')
    expect(notes.data.attributes.whatsNew).toBe('Bug fixes and improvements.')
    const addItem = JSON.parse(String(calls[9]!.init?.body))
    expect(addItem.data.relationships.reviewSubmission.data.id).toBe('sub-1')
    expect(addItem.data.relationships.appStoreVersion.data.id).toBe('ver-1')
    const patch = JSON.parse(String(calls[10]!.init?.body))
    expect(patch.data.attributes.submitted).toBe(true)
  })

  it('fills "What\'s New" only where it is empty — hand-written notes win', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { data: [{ id: 'build-1' }] } },
      { status: 200, body: { data: [{ id: 'ver-1' }] } },
      { status: 200, body: {} }, // attach build
      {
        status: 200,
        body: {
          data: [
            { id: 'loc-en', attributes: { whatsNew: 'Hand-written release notes.' } },
            { id: 'loc-zh', attributes: { whatsNew: '' } },
          ],
        },
      },
      { status: 200, body: {} }, // PATCH whatsNew — loc-zh only
      { status: 200, body: { data: [{ id: 'sub-1' }] } },
      { status: 200, body: { data: [{ relationships: { appStoreVersion: { data: { id: 'ver-1' } } } }] } },
      { status: 200, body: {} }, // PATCH submitted:true
    ])
    const result = await createSafariAdapter(fetch).submit(await creds(), { storeItemId: APP_ID }, zip, '1.2.0', 'macos')
    expect(result.submitted).toBe(true)
    const notePatches = calls.filter((c) => c.url.includes('/v1/appStoreVersionLocalizations/'))
    expect(notePatches).toHaveLength(1)
    expect(notePatches[0]!.url).toContain('loc-zh')
  })

  it('is idempotent against partial progress — reuses the version, the open draft, and an already-added item', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { data: [{ id: 'build-1' }] } }, // builds lookup
      { status: 200, body: { data: [{ id: 'ver-1', attributes: { versionString: '1.2.0' } }] } }, // version already exists
      { status: 200, body: {} }, // attach build
      { status: 200, body: { data: [{ id: 'loc-1', attributes: { whatsNew: 'Bug fixes and improvements.' } }] } }, // notes already set
      { status: 200, body: { data: [{ id: 'sub-1' }] } }, // open draft submission exists
      { status: 200, body: { data: [{ relationships: { appStoreVersion: { data: { id: 'ver-1' } } } }] } }, // item already added
      { status: 200, body: {} }, // PATCH submitted:true
    ])
    const result = await createSafariAdapter(fetch).submit(await creds(), { storeItemId: APP_ID }, zip, '1.2.0', 'macos')
    expect(result.submitted).toBe(true)
    // No POST /appStoreVersions, /reviewSubmissions, or /reviewSubmissionItems creations happened.
    const posts = calls.filter((c) => c.init?.method === 'POST')
    expect(posts).toHaveLength(0)
    // Without include, ASC omits relationships.appStoreVersion.data from the
    // items list entirely and the already-added check can never match
    // (Twitter Filter macOS v0.0.66, 2026-08-13).
    expect(calls[5]!.url).toContain('include=appStoreVersion')
  })

  it('renames a leftover editable version from a superseded push instead of creating alongside it', async () => {
    // ASC allows one editable version per platform. A submit that failed on
    // v0.17.9's metadata, followed by a push of v0.17.10, leaves the slot
    // occupied under the old number — a create 409s forever ("You cannot
    // create a new version of the App in the current state"; Redirector,
    // 2026-08-21). The slot must be adopted and renamed.
    const { fetch, calls } = queueFetch([
      { status: 200, body: { data: [{ id: 'build-2' }] } }, // builds lookup
      { status: 200, body: { data: [{ id: 'ver-1', attributes: { versionString: '1.1.9' } }] } }, // editable slot, older number
      { status: 200, body: {} }, // PATCH versionString
      { status: 200, body: {} }, // attach build
      { status: 200, body: { data: [{ id: 'loc-1', attributes: { whatsNew: 'Bug fixes and improvements.' } }] } },
      { status: 200, body: { data: [{ id: 'sub-1' }] } }, // open draft submission (the failed tick's leftover)
      { status: 200, body: { data: [] } }, // items lookup — empty
      { status: 201, body: {} }, // add item
      { status: 200, body: {} }, // PATCH submitted:true
    ])
    const result = await createSafariAdapter(fetch).submit(await creds(), { storeItemId: APP_ID }, zip, '1.2.0', 'macos')
    expect(result.submitted).toBe(true)
    expect(calls[2]!.url).toBe('https://api.appstoreconnect.apple.com/v1/appStoreVersions/ver-1')
    expect(calls[2]!.init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[2]!.init?.body)).data.attributes.versionString).toBe('1.2.0')
    // Adopted, not created: the only POST is the reviewSubmissionItems add.
    const posts = calls.filter((c) => c.init?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toContain('/v1/reviewSubmissionItems')
  })

  it('refuses to rename an editable version downward — a newer hand-prepared release is not our leftover', async () => {
    const { fetch, calls } = queueFetch([
      { status: 200, body: { data: [{ id: 'build-2' }] } }, // builds lookup
      { status: 200, body: { data: [{ id: 'ver-9', attributes: { versionString: '2.0.0' } }] } }, // editable slot, newer number
    ])
    const result = await createSafariAdapter(fetch).submit(await creds(), { storeItemId: APP_ID }, zip, '1.2.0', 'macos')
    expect(result.submitted).toBe(false)
    expect(result.waiting).toBeUndefined()
    expect(result.detail).toMatch(/editable macos version 2\.0\.0, newer than the queued v1\.2\.0/)
    expect(calls).toHaveLength(2) // stopped before any write
  })

  it("treats ASC's own \"already added\" 409 on the item add as the step succeeding", async () => {
    // The pre-check can still miss (response-shape drift, an item past the
    // page limit) — ASC saying the item is already in this submission is
    // exactly what step 5 set out to make true, so the flow continues to
    // the final confirm instead of stalling the release.
    const { fetch, calls } = queueFetch([
      { status: 200, body: { data: [{ id: 'build-1' }] } }, // builds lookup
      { status: 200, body: { data: [{ id: 'ver-1' }] } }, // version exists
      { status: 200, body: {} }, // attach build
      { status: 200, body: { data: [{ id: 'loc-1', attributes: { whatsNew: 'Bug fixes and improvements.' } }] } },
      { status: 200, body: { data: [{ id: 'sub-1' }] } }, // open draft submission
      { status: 200, body: { data: [{ relationships: {} }] } }, // items list missing relationship data
      { status: 409, body: '{"errors":[{"status":"409","code":"ENTITY_ERROR.RELATIONSHIP.INVALID.NOT_ALLOWED","title":"appStoreVersion with id ver-1 was already added to this reviewSubmission."}]}' },
      { status: 200, body: {} }, // PATCH submitted:true
    ])
    const result = await createSafariAdapter(fetch).submit(await creds(), { storeItemId: APP_ID }, zip, '1.2.0', 'macos')
    expect(result.submitted).toBe(true)
    const patch = JSON.parse(String(calls[7]!.init?.body))
    expect(patch.data.attributes.submitted).toBe(true)
  })

  it('surfaces a definite ASC rejection as a failure detail (not waiting)', async () => {
    const { fetch } = queueFetch([
      { status: 200, body: { data: [{ id: 'build-1' }] } },
      { status: 200, body: { data: [{ id: 'ver-1' }] } },
      { status: 409, body: 'export compliance missing' },
    ])
    const result = await createSafariAdapter(fetch).submit(await creds(), { storeItemId: APP_ID }, zip, '1.2.0', 'macos')
    expect(result.submitted).toBe(false)
    expect(result.waiting).toBeUndefined()
    expect(result.detail).toMatch(/build attach failed \(409\)/)
  })

  it('refuses to run without a platform', async () => {
    await expect(createSafariAdapter(unreachableFetch).submit(await creds(), { storeItemId: APP_ID }, zip, '1.2.0', 'watchos')).rejects.toThrow(
      /requires a platform/,
    )
  })
})
