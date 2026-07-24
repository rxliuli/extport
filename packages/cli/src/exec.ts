import { spawn } from 'node:child_process'

export interface ExecResult {
  stdout: string
  stderr: string
  status: number
}

export interface ExecOptions {
  /** Stream output to the current process live as it arrives. Off by
   * default — xcodebuild's own verbosity would otherwise drown out
   * extport's own progress lines; always still captured and returned
   * regardless, so a caller can print it after the fact (e.g. on failure). */
  stream?: boolean
}

export type Exec = (cmd: string, args: string[], options?: ExecOptions) => Promise<ExecResult>

/**
 * Runs a command, always capturing stdout/stderr for the caller (e.g. to
 * parse `xcodebuild -list -json`, or to print on failure) — live streaming
 * to the current process is opt-in via `options.stream`.
 */
export const exec: Exec = (cmd, args, options = {}) => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk
      if (options.stream) process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk
      if (options.stream) process.stderr.write(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, status: code ?? 1 }))
  })
}
