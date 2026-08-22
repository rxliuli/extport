// @ts-check
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightLinksValidator from 'starlight-links-validator'
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi'
import starlightThemeRapide from 'starlight-theme-rapide'
import starlightTypedoc, { createStarlightTypeDocPlugin, typeDocSidebarGroup } from 'starlight-typedoc'
import { stripDuplicateReadmeH1 } from './plugins/strip-readme-h1.mjs'

// A second starlight-typedoc instance needs its own sidebar group placeholder
// (the default `typeDocSidebarGroup` is a singleton for one instance).
const [starlightTypeDocWxt, wxtSidebarGroup] = createStarlightTypeDocPlugin()

// https://astro.build/config
export default defineConfig({
  site: 'https://docs.extport.dev',
  integrations: [
    starlight({
      title: 'extport',
      description: 'Publish a browser extension to every store, from one push.',
      favicon: '/favicon.png',
      // Default social-card image for every docs page (Starlight already
      // emits per-page og:title/description/canonical on its own).
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://extport.dev/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://extport.dev/og.png' } },
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/rxliuli/extport' },
        { icon: 'discord', label: 'Discord', href: 'https://discord.gg/Va9kcSqu3f' },
      ],
      editLink: {
        baseUrl: 'https://github.com/rxliuli/extport/edit/main/apps/docs/',
      },
      plugins: [
        // Theme first so it lays down the base styles; the content plugins
        // (openapi/typedoc) layer their own on top.
        starlightThemeRapide(),
        starlightOpenAPI([
          {
            base: 'api',
            schema: './public/openapi.json',
            sidebar: {
              collapsed: true,
              label: 'API reference',
              operations: { badges: true, labels: 'summary', sort: 'document' },
            },
          },
        ]),
        starlightTypedoc({
          entryPoints: ['../../packages/sdk/src/index.ts'],
          tsconfig: '../../packages/sdk/tsconfig.json',
          output: 'sdk',
          // `entryFileName: 'index'` puts the README overview at `/sdk/` (the
          // default would be `/sdk/readme/`). This works here because there is a
          // single entry point, so no nested `index` module collides.
          typeDoc: { entryFileName: 'index', readme: '../../packages/sdk/README.md' },
          sidebar: { collapsed: true, label: 'SDK reference' },
        }),
        starlightTypeDocWxt({
          entryPoints: ['../../packages/wxt/src/index.ts'],
          tsconfig: '../../packages/wxt/tsconfig.json',
          output: 'wxt',
          typeDoc: { entryFileName: 'index', readme: '../../packages/wxt/README.md' },
          sidebar: { collapsed: true, label: 'WXT reference' },
        }),
        // Runs after the two starlight-typedoc instances above have written
        // their generated markdown; strips the duplicate README H1 from the
        // `/sdk/` and `/wxt/` overview pages (the READMEs stay intact for npm).
        stripDuplicateReadmeH1(),
        // Build-time guard: fails the build on broken internal links across the
        // manual guides and the auto-generated API/SDK/WXT references.
        starlightLinksValidator(),
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [{ label: 'Getting started', slug: 'getting-started' }],
        },
        {
          label: 'Publishing',
          items: [
            { label: 'Push your first build', slug: 'publishing' },
            { label: 'Chrome', slug: 'stores/chrome' },
            { label: 'Firefox', slug: 'stores/firefox' },
            { label: 'Edge', slug: 'stores/edge' },
            { label: 'Safari', slug: 'stores/safari' },
          ],
        },
        {
          label: 'Licensing',
          items: [{ label: 'Sell activation codes', slug: 'licensing' }],
        },
        {
          label: 'Analytics',
          items: [{ label: 'Installs, users, and versions', slug: 'analytics' }],
        },
        // References come last — the guide pages first, reference at the end.
        // The SDK client and the WXT build module are what tenants reach for
        // daily; the raw REST API is only needed to bypass the CLI or wire up a
        // custom GitHub Actions step, so it sits below.
        typeDocSidebarGroup,
        wxtSidebarGroup,
        ...openAPISidebarGroups,
      ],
    }),
  ],
})
