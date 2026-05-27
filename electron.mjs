import { app, BaseWindow, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import { spawn, execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'tsx/esm/api'

// Run the TypeScript recording engine directly in the main process.
register()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const DEV_URL = 'http://localhost:5273'

// Chrome 140 — clears modern browser sniffers (Slack's min is Chrome 137).
// Keep in sync with the Sec-Ch-Ua header in window.ts and brands in popup-preload.cjs.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

app.userAgentFallback = USER_AGENT

// F12 / Ctrl+Shift+I per-webContents (control panel + any plain window). The
// recorder window binds its own handoff-aware handler in window.ts.
const bindDevTools = (contents) => {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }

    const isF12 = input.key === 'F12'
    const isCtrlShiftI = (input.control || input.meta) && input.shift && (input.key === 'I' || input.key === 'i')

    if (isF12 || isCtrlShiftI) {
      contents.toggleDevTools()
      event.preventDefault()
    }
  })
}

app.on('web-contents-created', (_event, contents) => {
  contents.setUserAgent(USER_AGENT)
})

Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ]),
)

let mainWindow = null
let activeRecording = null
let viteProcess = null

// Broadcast an event to every renderer (only the control panel listens).
function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send(channel, ...args)
    }
  }
}

// The control panel's view of the live recording: null when idle, or its
// identity while a run is in progress (so a panel reload re-syncs its banner).
function activeRecordingInfo() {
  if (!activeRecording || !activeRecording.runId) {
    return null
  }

  return { runId: activeRecording.runId, label: activeRecording.label }
}

// --- dev renderer server ---------------------------------------------------
// In development the React control panel is served by Vite (HMR). In a packaged
// build there is NO server: the renderer is pre-built to dist/ and loaded from
// disk via loadFile(). So we only spawn Vite when running unpackaged.

function startVite() {
  if (viteProcess) {
    return
  }

  console.log('Starting Vite dev server…')
  viteProcess = spawn('pnpm', ['dev'], { cwd: __dirname, shell: true, stdio: 'inherit' })
  viteProcess.on('error', (err) => console.error('Failed to start Vite:', err))
  viteProcess.on('exit', () => {
    viteProcess = null
  })
}

function stopVite() {
  if (!viteProcess) {
    return
  }

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${viteProcess.pid} /T /F`, { stdio: 'ignore' })
    } else {
      viteProcess.kill()
    }
  } catch {
    // already gone
  }

  viteProcess = null
}

// --- dynamic imports of the TS engine (tsx-loaded) -------------------------

const importEngine = (rel) => import(`file:///${join(__dirname, rel).replace(/\\/g, '/')}`)

const getSessionsRoot = async () => {
  const { getSessionsRoot } = await importEngine('src/main/config.ts')

  return getSessionsRoot()
}

// --- windows ---------------------------------------------------------------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'Decoy',
    icon: join(__dirname, 'public/decoy-icon.png'),
    backgroundColor: '#18181b',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  bindDevTools(mainWindow.webContents)

  if (isDev) {
    // Vite may still be booting when the window opens — retry until it answers.
    const loadDev = () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return
      }

      mainWindow.loadURL(DEV_URL).catch(() => {})
    }

    mainWindow.webContents.on('did-fail-load', (_e, errorCode) => {
      if (errorCode === -3) {
        return
      } // ERR_ABORTED — normal during navigation

      setTimeout(loadDev, 400)
    })
    loadDev()
  } else {
    void mainWindow.loadFile(join(__dirname, 'dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// --- IPC -------------------------------------------------------------------

ipcMain.handle('recording:start', async (_event, payload) => {
  if (activeRecording) {
    throw new Error('A recording is already in progress')
  }

  activeRecording = { pending: true }

  try {
    const startUrl = String(payload.startUrl ?? '')
    // Label is optional — fall back to the start URL's host.
    let label = String(payload.label ?? '').trim()

    if (!label) {
      try {
        label = new URL(startUrl).hostname.replace(/^www\./, '') || 'recording'
      } catch {
        label = 'recording'
      }
    }

    const { addUrlToHistory, getFilters } = await importEngine('src/main/config.ts')

    await addUrlToHistory(startUrl)
    const filters = await getFilters()

    const { createRecorderWindow } = await importEngine('src/main/recording/window.ts')

    const toolbarUrl = isDev
      ? `${DEV_URL}/recorder-toolbar/index.html`
      : `file:///${join(__dirname, 'dist/recorder-toolbar/index.html').replace(/\\/g, '/')}`

    const handle = await createRecorderWindow({
      label,
      startUrl,
      reuseSession: payload.reuseSession !== false,
      captureAll: Boolean(payload.captureAll),
      filters,
      autoRecord: payload.autoRecord ?? true,
      exportHar: payload.exportHar !== false,
      toolbarUrl,
      sessionsRoot: await getSessionsRoot(),
      userAgent: USER_AGENT,
      onProgress: (counts) => broadcast('recording:progress', counts),
      onClosed: () => {
        activeRecording = null
        broadcast('recording:finished')
      },
    })

    activeRecording = handle
    broadcast('recording:started', activeRecordingInfo())

    return { runId: handle.runId }
  } catch (err) {
    activeRecording = null
    throw err
  }
})

ipcMain.handle('recording:list', async () => {
  const { listRecordings } = await importEngine('src/main/recording/storage.ts')

  return listRecordings(await getSessionsRoot())
})

ipcMain.handle('recording:open-folder', async (_event, runId) => {
  if (typeof runId !== 'string' || runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
    throw new Error('invalid runId')
  }

  await shell.openPath(join(await getSessionsRoot(), runId))

  return { success: true }
})

ipcMain.handle('recording:delete', async (_event, runId) => {
  const { deleteRecording } = await importEngine('src/main/recording/storage.ts')

  await deleteRecording(await getSessionsRoot(), runId)

  return { success: true }
})

ipcMain.handle('recording:rename', async (_event, runId, name) => {
  if (typeof runId !== 'string' || runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
    throw new Error('invalid runId')
  }

  const { renameRecording } = await importEngine('src/main/recording/storage.ts')

  return renameRecording(await getSessionsRoot(), runId, String(name ?? ''))
})

ipcMain.on('recorder:toolbar-stop', () => {
  if (activeRecording && activeRecording.window) {
    activeRecording.window.close()
  }
})

ipcMain.on('recorder:toolbar-pause-toggle', () => {
  if (activeRecording && activeRecording.togglePause) {
    activeRecording.togglePause()
  }
})

ipcMain.handle('recording:active', () => activeRecordingInfo())

// Stop & save the live recording from the control panel (mirrors the toolbar Stop).
ipcMain.handle('recording:stop', () => {
  if (activeRecording && activeRecording.window) {
    activeRecording.window.close()
  }

  return { success: true }
})

// Confirm an irreversible delete with a native modal before the renderer removes the run.
ipcMain.handle('recording:confirm-delete', async (_event, label) => {
  const parent = mainWindow instanceof BaseWindow ? mainWindow : undefined
  const opts = {
    type: 'warning',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
    title: 'Delete recording',
    message: `Delete “${String(label ?? 'this recording')}”?`,
    detail: 'This permanently removes the run folder and everything in it. This cannot be undone.',
  }
  const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)

  return { confirmed: response === 1 }
})

ipcMain.handle('config:get', async () => {
  const { getConfig } = await importEngine('src/main/config.ts')

  return getConfig()
})

ipcMain.handle('config:set-sessions-root', async (_event, root) => {
  const { setSessionsRoot } = await importEngine('src/main/config.ts')

  return setSessionsRoot(String(root ?? ''))
})

ipcMain.handle('config:pick-folder', async () => {
  const parent = mainWindow instanceof BaseWindow ? mainWindow : undefined
  const result = parent
    ? await dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true }
  }

  return { canceled: false, path: result.filePaths[0] }
})

ipcMain.handle('config:clear-history', async () => {
  const { clearUrlHistory } = await importEngine('src/main/config.ts')

  return clearUrlHistory()
})

ipcMain.handle('config:set-filters', async (_event, filters) => {
  const { setFilters } = await importEngine('src/main/config.ts')

  return setFilters({
    skipResourceTypes: Array.isArray(filters?.skipResourceTypes) ? filters.skipResourceTypes.map(String) : [],
    blockHosts: Array.isArray(filters?.blockHosts) ? filters.blockHosts.map(String) : [],
  })
})

ipcMain.handle('config:reset-filters', async () => {
  const { resetFilters } = await importEngine('src/main/config.ts')

  return resetFilters()
})

// --- lifecycle -------------------------------------------------------------

app.whenReady().then(() => {
  // Apply the spoofed UA to the default session too (control panel uses it).
  session.defaultSession.setUserAgent(USER_AGENT)

  if (isDev) {
    startVite()
  }

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('before-quit', stopVite)

app.on('window-all-closed', () => {
  stopVite()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})
