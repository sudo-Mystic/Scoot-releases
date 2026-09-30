import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

// base './' keeps every asset relative so the build works when served
// under /Scoot-releases/sim/ on GitHub Pages.
//
// The source entry is app.html, NOT index.html: Pages serves sim/ root,
// so the shipped sim/index.html must be the built bundle (copied from
// dist/ by `npm run deploy`), never the Vite source shell that points
// at /src/main.js and cannot boot as a static page.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      input: { index: resolve(root, 'app.html') },
    },
  },
});
