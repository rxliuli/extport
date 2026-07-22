import { spawn } from 'node:child_process'

export interface ExecResult {
  stdout: string
  status: number
}

export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>

/**
 * Runs a command, streaming its output to the current process live (Xcode
 * archives take minutes — the tenant needs to see progress) while also
 * capturing stdout for callers that need to parse it (e.g. `xcodebuild
 * -list -json`).
 */
export const exec: Exec = (cmd, args) => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, status: code ?? 1 }))
  })
}
