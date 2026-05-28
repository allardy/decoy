import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

// Bundles the main process and preloads to plain JS (no runtime transpiler — the packaged app
// ships out/ and never spawns esbuild), and serves the renderer on an ephemeral dev port whose
// URL is injected into main via ELECTRON_RENDERER_URL.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: 'src/main/index.ts' } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          popup: 'src/preload/popup.ts',
          toolbar: 'src/preload/toolbar.ts',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      // Absolute paths — workspace-rooted strings fail vite's dev-mode optimizeDeps scanner
      // (which resolves rollupOptions.input against `root`) and surface as a misleading
      // "Cannot read properties of undefined (reading 'join')" TypeError in Vite 6.4.2.
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          toolbar: resolve(import.meta.dirname, 'src/renderer/recorder-toolbar/index.html'),
        },
      },
    },
  },
})
