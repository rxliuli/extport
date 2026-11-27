import { spawn } from 'node:child_process'

export interface RunOptions {
  cwd?: string
  /** Stream stdio straight through (default: true). When false, capture output and include it in errors on failure. */
  stream?: boolean
}

export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<void> {
  const stream = options.stream ?? true
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: stream ? 'inherit' : ['ignore', 'pipe', 'pipe'], cwd: options.cwd })
    let stdout = ''
    let stderr = ''
    if (!stream) {
      child.stdout?.on('data', (chunk) => (stdout += chunk))
      child.stderr?.on('data', (chunk) => (stderr += chunk))
    }
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else {
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
        reject(new Error(`${cmd} exited with code ${code}${detail ? `\n${detail}` : ''}`))
      }
    })
  })
}

/** Captures stdout instead of streaming it — for tools whose output we parse rather than show. */
export function capture(cmd: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${cmd} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    })
  })
}
