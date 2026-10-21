// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// cantorfm.com: the landing (src/pages/index.astro) and the docs under /docs,
// which Starlight renders from Markdown in src/content/docs/docs/.
export default defineConfig({
  site: 'https://cantorfm.com',
  integrations: [
    starlight({
      title: 'Cantor',
      description: 'Songs made on your own machine, heard on your phone.',
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
        { label: 'The node', items: [{ autogenerate: { directory: 'docs/node' } }] },
      ],
    }),
  ],
  vite: {
    // The art is the app's own geometry, imported from cantor/src.
    server: { fs: { allow: ['..'] } },
  },
});
