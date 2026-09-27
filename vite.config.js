import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        main: 'index.html',
        chat: 'chat.html',
      },
      output: {
        // Split the heavyweight renderer libs (pixi.js / @pixi/* /
        // pixi-live2d-display / lucide) out of the app chunk by top-level
        // package, so app code stays small and vendors are cached/stored
        // independently. Scoped packages (@pixi/*) share one chunk per scope.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // Rollup normalizes ids to forward slashes even on Windows, so a
          // leading path segment after the last node_modules/ is empty —
          // filter it out before reading the package name.
          const parts = id.split('node_modules').pop().split('/').filter(Boolean);
          const pkg = parts[0] || '';
          if (!pkg) return 'vendor-misc';
          // Keep the two heavyweight renderer libs in their own chunks (for
          // caching/organization) and fold every smaller transitive util
          // (qs, side-channel, get-intrinsic, ...) into ONE misc vendor chunk
          // so a file:// Electron load doesn't do dozens of small file reads.
          switch (pkg) {
            case 'pixi.js':
            case '@pixi':
              return 'vendor-pixi';
            case 'pixi-live2d-display':
              return 'vendor-live2d';
            default:
              return 'vendor-misc';
          }
        },
      },
    },
  },
});
