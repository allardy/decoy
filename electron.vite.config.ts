import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

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
      rollupOptions: {
        input: {
          index: 'src/renderer/index.html',
          toolbar: 'src/renderer/recorder-toolbar/index.html',
        },
      },
    },
  },
})
