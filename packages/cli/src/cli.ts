#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { buildPushUrl, parsePushArgs, USAGE, type PushOptions } from './args.js'
import { exec } from './exec.js'
import { SAFARI_BUILD_USAGE, parseSafariBuildArgs } from './safari-build-args.js'
import { runSafariBuild } from './safari-build.js'

const TOP_USAGE = `extport — publish browser extension artifacts

Commands:
  push           Upload an artifact to extport
  safari-build   Build, sign, and upload a Safari extension to App Store Connect

Run "extport <command> --help" for command-specific options.
`

function fail(message: string): void {
  console.error(`error: ${message}`)
  process.exit(1)
}

interface PushRequest {
  headers: Record<string, string>
  body?: Uint8Array | FormData
  label: string
}

async function readZip(path: string): Promise<Uint8Array<ArrayBuffer>> {
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch {
    throw new Error(`cannot read file: ${path}`)
  }
  return buf.slice()
}

async function buildPushRequest(options: PushOptions): Promise<PushRequest> {
  const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}` }

  if (!options.file) {
    // Safari: no binary travels through extport — this registers version intent only.
    return { headers, label: 'no file (version intent only)' }
  }

  const bytes = await readZip(options.file)
  if (options.sourceZip) {
    const sourceBytes = await readZip(options.sourceZip)
    const form = new FormData()
    form.set('file', new Blob([bytes]), 'extension.zip')
    form.set('source', new Blob([sourceBytes]), 'source.zip')
    return { headers, body: form, label: `${bytes.length} bytes + ${sourceBytes.length} source bytes` }
  }

  headers['content-type'] = 'application/zip'
  return { headers, body: bytes, label: `${bytes.length} bytes` }
}

async function runPush(rest: string[]): Promise<void> {
  let options: PushOptions
  try {
    options = parsePushArgs(rest, process.env)
  } catch (err) {
    fail(`${(err as Error).message}\n\n${USAGE}`)
    return
  }

  let request: PushRequest
  try {
    request = await buildPushRequest(options)
  } catch (err) {
    fail((err as Error).message)
    return
  }

  const target = `${options.extension}@${options.version}${options.store ? ` (${options.store})` : ''}`
  console.log(`pushing ${options.file ?? '(no file)'} → ${target}`)

  const res = await fetch(buildPushUrl(options), { method: 'POST', headers: request.headers, body: request.body })

  let json: { artifact?: { id: string; sha256: string | null }; deduplicated?: boolean; error?: string }
  try {
    json = (await res.json()) as typeof json
  } catch {
    fail(`unexpected response (${res.status})`)
    return
  }

  if (res.status === 201) {
    console.log(`uploaded ${target} (${request.label})`)
  } else if (res.ok && json.deduplicated) {
    console.log(`already uploaded ${target} — identical content, nothing to do`)
  } else {
    fail(`${json.error ?? `upload failed (${res.status})`}`)
  }
}

async function runSafariBuildCommand(rest: string[]): Promise<void> {
  if (process.platform !== 'darwin') {
    fail(`safari-build requires macOS (xcodebuild is not available on ${process.platform})`)
    return
  }

  let options
  try {
    options = parseSafariBuildArgs(rest, process.env)
  } catch (err) {
    fail(`${(err as Error).message}\n\n${SAFARI_BUILD_USAGE}`)
    return
  }

  const results = await runSafariBuild(options, exec)

  console.log('')
  let anyFailed = false
  for (const result of results) {
    if (result.ok) {
      console.log(`✅ ${result.platform}: uploaded`)
    } else {
      anyFailed = true
      console.log(`❌ ${result.platform}: ${result.error}`)
    }
  }
  if (anyFailed) process.exit(1)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(TOP_USAGE)
    return
  }
  if (command === 'push') {
    if (rest[0] === '--help' || rest[0] === '-h') {
      console.log(USAGE)
      return
    }
    await runPush(rest)
    return
  }
  if (command === 'safari-build') {
    if (rest[0] === '--help' || rest[0] === '-h') {
      console.log(SAFARI_BUILD_USAGE)
      return
    }
    await runSafariBuildCommand(rest)
    return
  }
  fail(`unknown command "${command}"\n\n${TOP_USAGE}`)
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
