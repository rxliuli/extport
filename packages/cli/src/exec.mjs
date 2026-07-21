// @ts-check
import { spawn } from 'node:child_process'

/**
 * Runs a command, streaming its output to the current process live (Xcode
 * archives take minutes — the tenant needs to see progress) while also
 * capturing stdout for callers that need to parse it (e.g. `xcodebuild
 * -list -json`).
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, status: number }>}
 */
export function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      stdout += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => process.stderr.write(chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, status: code ?? 1 }))
  })
}
