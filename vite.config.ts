import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The control-panel renderer. `base: './'` keeps asset URLs relative so the
// built index.html loads correctly from file:// in a packaged Electron app.
// Files under public/ (notably recorder-toolbar/) are copied verbatim into
// dist/, where the main process loads the recorder toolbar from in production.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
