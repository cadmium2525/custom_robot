import { defineConfig } from 'vite';

// GitHub Pages serves this project from /custom_robot/.
// Allow override for local dev / other hosts via BASE_PATH.
const base = process.env.BASE_PATH ?? '/custom_robot/';

// SINGLE=1 produces one self-contained bundle instead of split chunks, for
// hosts that can only serve a single inlined HTML file.
const single = process.env.SINGLE === '1';

export default defineConfig({
  base: single ? './' : base,
  build: {
    target: 'es2020',
    minify: 'terser',
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
      format: { comments: false },
    },
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: single
        ? { inlineDynamicImports: true }
        : {
            manualChunks(id) {
              if (id.includes('node_modules/three')) return 'three';
              if (id.includes('node_modules/peerjs')) return 'peer';
              return undefined;
            },
          },
    },
    // Inline every asset when building single-file.
    assetsInlineLimit: single ? 100 * 1024 * 1024 : 4096,
    cssCodeSplit: !single,
  },
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
