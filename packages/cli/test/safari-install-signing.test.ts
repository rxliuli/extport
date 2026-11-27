import { describe, expect, it } from 'vitest'
import type { Exec } from '../src/exec'
import { parseDevicectlDevices, selectIosDevice } from '../src/safari-install-devices'
import {
  discoverSigningIdentities,
  extractOuFromSubject,
  parseCertPemBlocks,
  parseFindIdentityOutput,
  selectSigningIdentity,
  type SigningIdentity,
} from '../src/safari-install-signing'

const SHA_DEV = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SHA_DIST = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const SHA_DEVID = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'

const SAMPLE_IDENTITIES_OUT = `  1) ${SHA_DEV} "Apple Development: KAI WANG (DF3BVL824L)"
  2) ${SHA_DIST} "Apple Distribution: KAI WANG (N2X78TUUFG)"
  3) ${SHA_DEVID} "Developer ID Application: KAI WANG (N2X78TUUFG)"
     3 valid identities found`

describe('signing identity discovery', () => {
  it('parses usable identities and ignores Apple Distribution', () => {
    const parsed = parseFindIdentityOutput(SAMPLE_IDENTITIES_OUT)
    expect(parsed).toEqual([
      { sha1: SHA_DEV, name: 'Apple Development: KAI WANG (DF3BVL824L)', kind: 'apple-development' },
      {
        sha1: SHA_DEVID,
        name: 'Developer ID Application: KAI WANG (N2X78TUUFG)',
        kind: 'developer-id-application',
        platformScope: 'macos',
      },
    ])
  })

  it('extracts OU from both RFC2253 and legacy slash-separated OpenSSL subjects', () => {
    expect(
      extractOuFromSubject(
        'subject=UID=NNADBHFHZF, CN=Apple Development: KAI WANG (DF3BVL824L), OU=N2X78TUUFG, O=KAI WANG, C=US',
      ),
    ).toBe('N2X78TUUFG')
    expect(extractOuFromSubject('subject= /UID=X/CN=Apple Development/OU=TEAM123456/O=Me/C=US')).toBe('TEAM123456')
  })

  it('maps SHA-1 hashes to PEM blocks from security find-certificate', () => {
    const map = parseCertPemBlocks(
      `SHA-1 hash: ${SHA_DEV}\n-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n`,
    )
    expect(map.get(SHA_DEV)).toBe('-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----')
  })

  it('discovers macOS and iOS identities with Team ID from X.509 OU', async () => {
    const exec: Exec = async (cmd, args, opts) => {
      if (cmd === 'security' && args[0] === 'find-identity')
        return { status: 0, stdout: SAMPLE_IDENTITIES_OUT, stderr: '' }
      if (cmd === 'security' && args[0] === 'find-certificate') {
        return {
          status: 0,
          stdout: [
            `SHA-1 hash: ${SHA_DEV}\n-----BEGIN CERTIFICATE-----\nDEV\n-----END CERTIFICATE-----`,
            `SHA-1 hash: ${SHA_DEVID}\n-----BEGIN CERTIFICATE-----\nDEVID\n-----END CERTIFICATE-----`,
          ].join('\n'),
          stderr: '',
        }
      }
      if (cmd === 'openssl') {
        const ou = opts?.input?.includes('DEVID') ? 'OTHERTEAM1' : 'N2X78TUUFG'
        return { status: 0, stdout: `subject=CN=Test, OU=${ou}, C=US\n`, stderr: '' }
      }
      return { status: 1, stdout: '', stderr: '' }
    }

    const mac = await discoverSigningIdentities('macos', exec)
    expect(mac.map((i) => ({ kind: i.kind, teamId: i.teamId }))).toEqual([
      { kind: 'apple-development', teamId: 'N2X78TUUFG' },
      { kind: 'developer-id-application', teamId: 'OTHERTEAM1' },
    ])

    const ios = await discoverSigningIdentities('ios', exec)
    expect(ios).toHaveLength(1)
    expect(ios[0]!.kind).toBe('apple-development')
    expect(ios[0]!.teamId).toBe('N2X78TUUFG')
  })
})

describe('selectSigningIdentity', () => {
  const dev: SigningIdentity = {
    sha1: SHA_DEV,
    name: 'Apple Development: Me (PERS1)',
    kind: 'apple-development',
    teamId: 'TEAM123456',
  }
  const devId: SigningIdentity = {
    sha1: SHA_DEVID,
    name: 'Developer ID Application: Me (TEAM123456)',
    kind: 'developer-id-application',
    platformScope: 'macos',
    teamId: 'TEAM123456',
  }

  it('falls back to ad-hoc on macOS when Keychain has no certificates', async () => {
    const res = await selectSigningIdentity({ platform: 'macos', identities: [], hasOutput: false, isTTY: false })
    expect(res).toEqual({ mode: 'adhoc', reason: 'fallback' })
  })

  it('auto-selects a single matching identity', async () => {
    const res = await selectSigningIdentity({ platform: 'macos', identities: [dev], hasOutput: false, isTTY: false })
    expect(res).toEqual({ mode: 'identity', identity: dev, teamId: 'TEAM123456' })
  })

  it('prompts when multiple identities exist on a TTY', async () => {
    const res = await selectSigningIdentity({
      platform: 'macos',
      identities: [dev, devId],
      hasOutput: false,
      isTTY: true,
      promptSelect: async () => devId,
    })
    expect(res).toEqual({ mode: 'identity', identity: devId, teamId: 'TEAM123456' })
  })

  it('fails in non-TTY when multiple identities exist without --sign', async () => {
    await expect(
      selectSigningIdentity({ platform: 'macos', identities: [dev, devId], hasOutput: false, isTTY: false }),
    ).rejects.toThrow(/multiple macos signing identities/)
  })

  it('matches --sign by name substring or SHA-1', async () => {
    const byName = await selectSigningIdentity({
      platform: 'macos',
      identities: [dev, devId],
      signQuery: 'developer id',
      hasOutput: false,
      isTTY: false,
    })
    expect(byName).toEqual({ mode: 'identity', identity: devId, teamId: 'TEAM123456' })
  })

  it('rejects --no-sign on iOS without --output', async () => {
    await expect(
      selectSigningIdentity({ platform: 'ios', identities: [dev], noSign: true, hasOutput: false, isTTY: false }),
    ).rejects.toThrow(/--no-sign on iOS requires --output/)
  })
})

describe('devicectl device parsing & selection', () => {
  it('filters out simulators and reads both new properties.* and legacy fields', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            identifier: 'SIM-1',
            visibilityClass: 'simulators',
            properties: {
              hardware: { platform: 'iOS', reality: 'virtual', marketingName: 'iPhone 16' },
              connection: { transportType: 'sameMachine', pairingState: 'paired' },
            },
          },
          {
            identifier: 'PHYS-NEW',
            visibilityClass: 'default',
            properties: {
              hardware: { platform: 'iOS', reality: 'physical', udid: 'UDID-1', marketingName: 'iPhone 16 Pro' },
              connection: { tunnelState: 'connected', transportType: 'wired', pairingState: 'paired' },
              software: {
                osVersionNumber: { components: [27, 2, 1, 0, 0], originalComponentsCount: 3, stringValue: '27.2.1' },
              },
              state: { name: 'My iPhone' },
            },
          },
          {
            identifier: 'PHYS-LEGACY',
            hardwareProperties: { platform: 'iOS', reality: 'physical', udid: 'UDID-2', marketingName: 'iPad Air' },
            connectionProperties: { tunnelState: 'disconnected', pairingState: 'unpaired' },
            deviceProperties: { name: 'Old iPad', osVersionNumber: '17.6' },
          },
        ],
      },
    })

    const devices = parseDevicectlDevices(json)
    expect(devices).toEqual([
      {
        identifier: 'PHYS-NEW',
        name: 'My iPhone',
        udid: 'UDID-1',
        model: 'iPhone 16 Pro',
        osVersion: '27.2.1',
        connected: true,
      },
      {
        identifier: 'PHYS-LEGACY',
        name: 'Old iPad',
        udid: 'UDID-2',
        model: 'iPad Air',
        osVersion: '17.6',
        connected: false,
      },
    ])
  })

  it('matches --device by name or UDID and prompts when multiple', async () => {
    const devices = [
      { identifier: 'A', name: 'Work iPhone', udid: '1111', connected: true },
      { identifier: 'B', name: 'Personal iPad', udid: '2222', connected: true },
    ]
    expect(await selectIosDevice({ devices, query: '2222', isTTY: false })).toBe(devices[1])
    expect(await selectIosDevice({ devices, isTTY: true, promptSelect: async (list) => list[0]! })).toBe(devices[0])
    await expect(selectIosDevice({ devices: [], isTTY: false })).rejects.toThrow(/no physical iOS device found/)
  })
})
