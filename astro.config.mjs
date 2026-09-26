import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { SITE } from './src/site.config.js';

export default defineConfig({
  site: SITE.url,
  trailingSlash: 'always',
  integrations: [sitemap()],
});
