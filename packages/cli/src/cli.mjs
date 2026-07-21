#!/usr/bin/env node
// @ts-check
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { buildPushUrl, parsePushArgs, USAGE } from './args.mjs'
import { exec } from './exec.mjs'
import { SAFARI_BUILD_USAGE, parseSafariBuildArgs } from './safari-build-args.mjs'
import { runSafariBuild } from './safari-build.mjs'

const TOP_USAGE = `extport — publish browser extension artifacts

Commands:
  push           Upload an artifact to extport
  safari-build   Build, sign, and upload a Safari extension to App Store Connect

Run "extport <command> --help" for command-specific options.
`

/** @param {string} message */
function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

/** @param {string[]} rest */
async function runPush(rest) {
  let options
  try {
    options = parsePushArgs(rest, process.env)
  } catch (err) {
    fail(`${/** @type {Error} */ (err).message}\n\n${USAGE}`)
    return
  }

  let body
  try {
    body = await readFile(options.file)
  } catch {
    fail(`cannot read file: ${options.file}`)
    return
  }

  const target = `${options.extension}@${options.version}${options.store ? ` (${options.store})` : ''}`
  console.log(`pushing ${options.file} → ${target}`)

  const res = await fetch(buildPushUrl(options), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/zip',
    },
    body,
  })

  /** @type {{ artifact?: { id: string, sha256: string }, deduplicated?: boolean, error?: string }} */
  let json
  try {
    json = /** @type {typeof json} */ (await res.json())
  } catch {
    fail(`unexpected response (${res.status})`)
    return
  }

  if (res.status === 201) {
    console.log(`uploaded ${target} (${json.artifact?.sha256.slice(0, 12)}…, ${body.length} bytes)`)
  } else if (res.ok && json.deduplicated) {
    console.log(`already uploaded ${target} — identical content, nothing to do`)
  } else {
    fail(`${json.error ?? `upload failed (${res.status})`}`)
  }
}

/** @param {string[]} rest */
async function runSafariBuildCommand(rest) {
  if (process.platform !== 'darwin') {
    fail(`safari-build requires macOS (xcodebuild is not available on ${process.platform})`)
    return
  }

  let options
  try {
    options = parseSafariBuildArgs(rest, process.env)
  } catch (err) {
    fail(`${/** @type {Error} */ (err).message}\n\n${SAFARI_BUILD_USAGE}`)
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

async function main() {
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
