import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * starlight-typedoc writes `src/content/docs/sdk/index.md` (and `wxt/...`) with
 * a `title` frontmatter equal to the package name, then inlines the package
 * README as the body — which opens with the same `# @extport/sdk` H1. Starlight
 * renders the frontmatter title as the page heading, so the README's own H1
 * shows a second, duplicate title.
 *
 * We keep the READMEs intact (they're also the npm/GitHub READMEs, where the
 * H1 is required), and instead strip the now-redundant leading H1 from the
 * docs-generated overview page after starlight-typedoc has written it. This
 * runs in `config:setup`, after the starlight-typedoc plugin instances whose
 * own `config:setup` hooks generate the markdown, and before the content
 * collection is rendered.
 */
export function stripDuplicateReadmeH1() {
  return {
    name: 'strip-duplicate-readme-h1',
    hooks: {
      'config:setup'() {
        const here = dirname(fileURLToPath(import.meta.url))
        for (const output of ['sdk', 'wxt']) {
          const file = resolve(here, '../src/content/docs', output, 'index.md')
          if (!existsSync(file)) continue

          const src = readFileSync(file, 'utf8')
          const title = /^title:\s*"([^"]*)"/m.exec(src)?.[1]
          if (!title) continue

          const frontmatterMatch = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
          if (!frontmatterMatch) continue
          const [, frontmatter, body] = frontmatterMatch

          const h1 = `# ${title}`
          // Only strip if the body's very first line is the same H1.
          const stripped = body.replace(new RegExp(`^\\s*${escapeRegExp(h1)}\\s*\\n+`), '')
          if (stripped !== body) {
            writeFileSync(file, `---\n${frontmatter}\n---\n\n${stripped}`)
            console.log(`[strip-duplicate-readme-h1] stripped duplicate H1 -> ${file}`)
          }
        }
      },
    },
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
