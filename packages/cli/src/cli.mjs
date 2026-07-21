#!/usr/bin/env node
// @ts-check
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { buildPushUrl, parsePushArgs, USAGE } from './args.mjs'

/** @param {string} message */
function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return
  }
  if (command !== 'push') {
    fail(`unknown command "${command}"\n\n${USAGE}`)
    return
  }

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

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
