import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateOpenApiSpec } from '@extport/api/openapi'

/**
 * Regenerate the OpenAPI 3.1 document for the public API into `public/openapi.json`,
 * where `starlight-openapi` picks it up at build time.
 *
 * The spec is derived from the live route definitions in `@extport/api`, so the
 * generation lives here (the docs site owns the reference) but reads the API's
 * router + shared `OPENAPI_DOCUMENTATION`. Run automatically via the docs
 * package's `predev` / `prebuild` hooks, so it can never drift. No Cloudflare
 * bindings or running Worker required — hono-openapi's `generateSpecs` is pure.
 *
 * Run manually with: `pnpm --filter @extport/docs generate:openapi`
 */
async function main() {
  const spec = await generateOpenApiSpec()

  // Resolve relative to this script so it works regardless of CWD.
  const fromHere = (...segments: string[]) => resolve(dirname(fileURLToPath(import.meta.url)), ...segments)
  const out = fromHere('../public/openapi.json')

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`)
  console.log(`Wrote OpenAPI spec (${Object.keys(spec.paths ?? {}).length} paths) -> ${out}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
