import { defineConfig } from 'vite';

// GitHub Pages serves this project from /custom_robot/.
// Allow override for local dev / other hosts via BASE_PATH.
const base = process.env.BASE_PATH ?? '/custom_robot/';

export default defineConfig({
  base,
  build: {
    target: 'es2020',
    minify: 'terser',
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
      format: { comments: false },
    },
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/peerjs')) return 'peer';
          return undefined;
        },
      },
    },
  },
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
