// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { writeFileSync } from 'node:fs';
import { faviconHref } from './src/lib/app-icon.mjs';
import { REDIRECTS } from './src/site.ts';

/** Writes the short addresses (src/site.ts) as the host's `_redirects`. */
const redirects = {
  name: 'cantor-redirects',
  hooks: {
    'astro:build:done': ({ dir }) => {
      const lines = Object.entries(REDIRECTS).map(([from, to]) => `${from} ${to} 302`);
      writeFileSync(new URL('_redirects', dir), `${lines.join('\n')}\n`);
    },
  },
};

// cantorfm.com: the landing (src/pages/index.astro) and the docs under /docs,
// which Starlight renders from Markdown in src/content/docs/docs/.
export default defineConfig({
  site: 'https://cantorfm.com',
  integrations: [
    redirects,
    starlight({
      title: 'Cantor',
      description: 'Songs made on your own computer, kept on your phone.',
      favicon: faviconHref(),
      customCss: ['./src/styles/fonts.css', './src/styles/tokens.css', './src/styles/theme.css'],
      components: {
        SiteTitle: './src/components/starlight/SiteTitle.astro',
        PageTitle: './src/components/starlight/PageTitle.astro',
        PageSidebar: './src/components/starlight/PageSidebar.astro',
        Pagination: './src/components/starlight/Pagination.astro',
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/ckadirt/Cantor' }],
      editLink: { baseUrl: 'https://github.com/ckadirt/Cantor/edit/main/docs/' },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { slug: 'docs' },
            { slug: 'docs/start' },
          ],
        },
        {
          label: 'The node',
          items: [
            { slug: 'docs/node', label: 'Overview' },
            {
              label: 'Running',
              items: ['status', 'start', 'stop', 'restart', 'logs', 'run'].map((c) => `docs/node/${c}`),
            },
            {
              label: 'Models',
              items: ['pull', 'list', 'rm', 'backends'].map((c) => `docs/node/${c}`),
            },
            {
              label: 'Phones',
              items: ['pair', 'pairings', 'revoke', 'rename'].map((c) => `docs/node/${c}`),
            },
            { label: 'Making', items: ['docs/node/generate'] },
            { label: 'Updating', items: ['docs/node/upgrade'] },
            { slug: 'docs/node/files' },
          ],
        },
      ],
    }),
  ],
  vite: {
    // The art is the app's own geometry, imported from cantor/src.
    server: { fs: { allow: ['..'] } },
  },
});
