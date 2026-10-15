import { defineConfig } from 'vite';

export default defineConfig({
  server: { open: true },
  // three.js alone is ~550 kB minified; that's expected for a 3D app.
  build: { chunkSizeWarningLimit: 1000 },
});
