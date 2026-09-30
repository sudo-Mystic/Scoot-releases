import { defineConfig } from 'vite';

// base './' keeps every asset relative so the build works when served
// under /Scoot-releases/sim/ on GitHub Pages.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2020',
  },
});
