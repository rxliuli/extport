import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { Exec } from '../src/exec'
import { compareSemver, detectInstallSource, formatExternalUpgradeMessage, runUpgrade } from '../src/upgrade'

describe('compareSemver', () => {
  it('orders major, minor, patch, and prerelease versions', () => {
    expect(compareSemver('0.0.14', '0.0.13')).toBeGreaterThan(0)
    expect(compareSemver('0.0.13', '0.0.13')).toBe(0)
    expect(compareSemver('0.0.13', '0.0.14')).toBeLessThan(0)
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.1')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
  })
})

describe('detectInstallSource', () => {
  it('recognizes explicit standalone installer marker regardless of path', () => {
    expect(
      detectInstallSource({
        env: { EXTPORT_INSTALL_METHOD: 'installer' },
        scriptPath: '/Users/alice/.extport/app/dist/cli.mjs',
      }),
    ).toEqual({ kind: 'installer' })
  })

  it('distinguishes temporary runners and global package managers', () => {
    expect(
      detectInstallSource({ scriptPath: '/Users/a/.npm/_npx/1234/node_modules/@extport/cli/dist/cli.mjs' }),
    ).toEqual({ kind: 'npx', upgradeCommand: 'npx @extport/cli@latest' })
    expect(
      detectInstallSource({
        scriptPath: '/Users/a/Library/Caches/pnpm/dlx/abcd/node_modules/@extport/cli/dist/cli.mjs',
      }),
    ).toEqual({ kind: 'pnpx', upgradeCommand: 'pnpm dlx @extport/cli@latest' })
    expect(detectInstallSource({ scriptPath: '/Users/a/.bun/install/cache/@extport/cli@0.0.13/dist/cli.mjs' })).toEqual(
      { kind: 'bunx', upgradeCommand: 'bunx @extport/cli@latest' },
    )
    expect(
      detectInstallSource({
        scriptPath: '/Users/a/Library/pnpm/global/5/node_modules/@extport/cli/dist/cli.mjs',
      }),
    ).toEqual({ kind: 'pnpm', upgradeCommand: 'pnpm add -g @extport/cli@latest' })
    expect(
      detectInstallSource({ scriptPath: '/Users/a/.bun/install/global/node_modules/@extport/cli/dist/cli.mjs' }),
    ).toEqual({ kind: 'bun', upgradeCommand: 'bun add -g @extport/cli@latest' })
    expect(
      detectInstallSource({ scriptPath: '/Users/a/.config/yarn/global/node_modules/@extport/cli/dist/cli.mjs' }),
    ).toEqual({ kind: 'yarn', upgradeCommand: 'yarn global add @extport/cli@latest' })
    expect(detectInstallSource({ scriptPath: '/opt/homebrew/lib/node_modules/@extport/cli/dist/cli.mjs' })).toEqual({
      kind: 'npm',
      upgradeCommand: 'npm install -g @extport/cli@latest',
    })
    expect(detectInstallSource({ scriptPath: '/Users/a/code/extport/packages/cli/dist/cli.mjs' })).toEqual({
      kind: 'unknown',
    })
  })
})

describe('formatExternalUpgradeMessage', () => {
  it('explains how to update for npx, global managers, and unknown sources', () => {
    expect(formatExternalUpgradeMessage({ kind: 'npx', upgradeCommand: 'npx @extport/cli@latest' })).toContain(
      'npx @extport/cli@latest',
    )
    expect(formatExternalUpgradeMessage({ kind: 'pnpm', upgradeCommand: 'pnpm add -g @extport/cli@latest' })).toContain(
      'pnpm add -g @extport/cli@latest',
    )
    expect(formatExternalUpgradeMessage({ kind: 'unknown' })).toContain('https://extport.dev/install.sh')
  })
})

describe('runUpgrade', () => {
  const noopExec: Exec = async () => ({ stdout: '', stderr: '', status: 0 })

  function mockFetch(routes: Record<string, { status?: number; body: string }>): typeof globalThis.fetch {
    return (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const hit = routes[url]
      if (!hit) return new Response('not found', { status: 404 })
      return new Response(hit.body, { status: hit.status ?? 200 })
    }) as typeof globalThis.fetch
  }

  it('prints guidance without executing installer for non-installer sources', async () => {
    const logs: string[] = []
    let execCalled = false
    const res = await runUpgrade(
      { currentVersion: '0.0.13' },
      {
        exec: async () => {
          execCalled = true
          return { stdout: '', stderr: '', status: 0 }
        },
        env: {},
        scriptPath: '/Users/a/Library/pnpm/global/5/node_modules/@extport/cli/dist/cli.mjs',
        fetch: mockFetch({
          'https://registry.npmjs.org/@extport/cli/latest': { body: JSON.stringify({ version: '0.0.14' }) },
        }),
        log: (m) => logs.push(m),
      },
    )

    expect(execCalled).toBe(false)
    expect(res.status).toBe('managed-externally')
    expect(logs.join('\n')).toContain('0.0.13 → v0.0.14 is available')
    expect(logs.join('\n')).toContain('pnpm add -g @extport/cli@latest')
  })

  it('short-circuits when standalone installer is already up to date', async () => {
    const logs: string[] = []
    let execCalled = false
    const res = await runUpgrade(
      { currentVersion: '0.0.13' },
      {
        exec: async () => {
          execCalled = true
          return { stdout: '', stderr: '', status: 0 }
        },
        env: { EXTPORT_INSTALL_METHOD: 'installer' },
        fetch: mockFetch({
          'https://registry.npmjs.org/@extport/cli/latest': { body: JSON.stringify({ version: '0.0.13' }) },
        }),
        log: (m) => logs.push(m),
      },
    )

    expect(execCalled).toBe(false)
    expect(res.status).toBe('up-to-date')
    expect(logs).toContain('extport v0.0.13 is already up to date.')
  })

  it('fetches install.sh and executes it with EXTPORT_UPGRADE=1 when a newer version exists', async () => {
    const logs: string[] = []
    let capturedCmd = ''
    let capturedScript = ''
    let capturedUpgradeEnv = ''
    const fakeScript = '#!/bin/sh\necho upgraded\n'

    const res = await runUpgrade(
      { currentVersion: '0.0.13' },
      {
        exec: async (cmd, args, opts) => {
          capturedCmd = cmd
          capturedScript = await readFile(args[0]!, 'utf8')
          capturedUpgradeEnv = opts?.env?.EXTPORT_UPGRADE ?? ''
          return { stdout: 'upgraded\n', stderr: '', status: 0 }
        },
        env: { EXTPORT_INSTALL_METHOD: 'installer', EXTPORT_HOME: '/tmp/custom-extport' },
        fetch: mockFetch({
          'https://registry.npmjs.org/@extport/cli/latest': { body: JSON.stringify({ version: '0.0.14' }) },
          'https://extport.dev/install.sh': { body: fakeScript },
        }),
        log: (m) => logs.push(m),
      },
    )

    expect(res.status).toBe('upgraded')
    expect(capturedCmd).toBe('/bin/sh')
    expect(capturedScript).toBe(fakeScript)
    expect(capturedUpgradeEnv).toBe('1')
    expect(logs.join('\n')).toContain('Upgrading extport v0.0.13 → v0.0.14')
  })

  it('reinstalls when --force is passed even if already on the latest version', async () => {
    let execCount = 0
    const res = await runUpgrade(
      { currentVersion: '0.0.13', force: true },
      {
        exec: async () => {
          execCount++
          return { stdout: '', stderr: '', status: 0 }
        },
        env: { EXTPORT_INSTALL_METHOD: 'installer' },
        fetch: mockFetch({
          'https://registry.npmjs.org/@extport/cli/latest': { body: JSON.stringify({ version: '0.0.13' }) },
          'https://extport.dev/install.sh': { body: '#!/bin/sh\nexit 0\n' },
        }),
        log: () => {},
      },
    )

    expect(res.status).toBe('upgraded')
    expect(execCount).toBe(1)
  })

  it('refuses to execute non-shell responses from the installer URL', async () => {
    await expect(
      runUpgrade(
        { currentVersion: '0.0.13' },
        {
          exec: noopExec,
          env: { EXTPORT_INSTALL_METHOD: 'installer' },
          fetch: mockFetch({
            'https://registry.npmjs.org/@extport/cli/latest': { body: JSON.stringify({ version: '0.0.14' }) },
            'https://extport.dev/install.sh': { body: '<html>404</html>' },
          }),
          log: () => {},
        },
      ),
    ).rejects.toThrow(/expected a #!\/bin\/sh script/)
  })
})
