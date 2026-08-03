// @ts-check
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

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
      ],
    }),
  ],
})
