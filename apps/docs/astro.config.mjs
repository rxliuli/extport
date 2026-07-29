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
          label: 'Licensing',
          items: [{ label: 'Sell activation codes', slug: 'licensing' }],
        },
        {
          label: 'Stores',
          items: [
            { label: 'Chrome', slug: 'stores/chrome' },
            { label: 'Firefox', slug: 'stores/firefox' },
            { label: 'Edge', slug: 'stores/edge' },
            { label: 'Safari', slug: 'stores/safari' },
          ],
        },
      ],
    }),
  ],
})
