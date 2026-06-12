import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type WebContents,
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { hasChromeSession, launchLoginChrome, removeChromeSession } from './chrome-login.js'
import type { DecoyConfig, Profile } from './config-core.js'
import {
  addUrlToHistory,
  clearUrlHistory,
  createProfile,
  deleteProfile,
  getConfig,
  getFilters,
  getSessionsRoot,
  resetFilters,
  setChromeLogin,
  setFilters,
  setLastProfileId,
  setSessionsRoot,
} from './config.js'
import { deleteRecording, listRecordings, renameRecording } from './recording/storage.js'
import { createRecorderWindow, REUSE_PARTITION, type RecordingHandle } from './recording/window.js'

// Map a profile selection to its session partition. "fresh" → undefined (a throwaway per-run
// session); "default" → the legacy shared partition; a known custom id → its own partition.
// An unknown id falls back to Default rather than silently spinning up an orphan session.
function resolvePartition(profileId: string, profiles: Profile[]): string | undefined {
  if (profileId === 'fresh') {
    return undefined
  }

  if (profileId === 'default') {
    return REUSE_PARTITION
  }

  return profiles.some((p) => p.id === profileId) ? `persist:decoy-${profileId}` : REUSE_PARTITION
}

// Does this profile selection sign in via the real-Chrome escape hatch? "fresh" never does (a
// throwaway session can't carry a login); "default" reads the config flag; custom reads its profile.
function isChromeLogin(profileId: string, cfg: DecoyConfig): boolean {
  if (profileId === 'default') {
    return cfg.defaultChromeLogin
  }

  return cfg.profiles.some((p) => p.id === profileId && p.chromeLogin === true)
}

// In dev, electron-vite serves the renderer on an ephemeral port and sets this. In a packaged
// build it is undefined and the renderer is loaded from disk via loadFile().
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL

// Chrome 140 — clears modern browser sniffers (Slack's min is Chrome 137).
// Keep in sync with the Sec-Ch-Ua header in recording/window.ts and brands in preload/popup.ts.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// Window icon: shipped to resources/ via electron-builder extraResources when packaged; the
// repo's build/icon.png in dev (import.meta.dirname is out/main in both dev and packaged builds).
const WINDOW_ICON = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(import.meta.dirname, '../../build/icon.png')

app.userAgentFallback = USER_AGENT

// F12 / Ctrl+Shift+I per-webContents (control panel + any plain window). The recorder window
// binds its own handoff-aware handler in recording/window.ts.
const bindDevTools = (contents: WebContents): void => {
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

let mainWindow: BrowserWindow | null = null
let activeRecording: RecordingHandle | null = null
let starting = false

// Broadcast an event to every renderer (only the control panel listens).
function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send(channel, ...args)
    }
  }
}

// The control panel's view of the live recording: null when idle, or its identity while a run
// is in progress (so a panel reload re-syncs its banner).
function activeRecordingInfo(): { runId: string; label: string } | null {
  if (!activeRecording) {
    return null
  }

  return { runId: activeRecording.runId, label: activeRecording.label }
}

// In dev the toolbar is served by the dev server; in prod it's a built renderer entry on disk.
function toolbarUrlBase(): string {
  if (RENDERER_URL) {
    return `${RENDERER_URL}/recorder-toolbar/index.html`
  }

  return pathToFileURL(join(import.meta.dirname, '../renderer/recorder-toolbar/index.html')).href
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 1000,
    title: 'Decoy',
    icon: WINDOW_ICON,
    backgroundColor: '#18181b',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  bindDevTools(mainWindow.webContents)

  if (RENDERER_URL) {
    void mainWindow.loadURL(RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// --- IPC -------------------------------------------------------------------

ipcMain.handle('recording:start', async (_event, payload) => {
  if (activeRecording || starting) {
    throw new Error('A recording is already in progress')
  }

  starting = true

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

    await addUrlToHistory(startUrl)
    const filters = await getFilters()
    const cfg = await getConfig()
    const profileId = String(payload.profileId ?? cfg.lastProfileId ?? 'default')
    const partition = resolvePartition(profileId, cfg.profiles)

    // A chrome-login profile must be signed in first — its cookies are mirrored from real Chrome,
    // and recording in the webview before that just lands a logged-out session.
    if (partition && isChromeLogin(profileId, cfg) && !hasChromeSession(partition)) {
      throw new Error('This profile signs in with real Chrome — click "Log in (Chrome)" and sign in first.')
    }

    await setLastProfileId(profileId)

    const handle = await createRecorderWindow({
      label,
      startUrl,
      partition,
      captureAll: Boolean(payload.captureAll),
      filters,
      autoRecord: payload.autoRecord ?? true,
      exportHar: payload.exportHar !== false,
      toolbarUrl: toolbarUrlBase(),
      sessionsRoot: await getSessionsRoot(),
      userAgent: USER_AGENT,
      icon: WINDOW_ICON,
      onProgress: (counts) => broadcast('recording:progress', counts),
      onClosed: () => {
        activeRecording = null
        broadcast('recording:finished')
      },
    })

    activeRecording = handle
    broadcast('recording:started', activeRecordingInfo())

    return { runId: handle.runId }
  } finally {
    starting = false
  }
})

// EXPERIMENT: sign in via the user's REAL Chrome over CDP, then mirror the cookies into the selected
// profile's partition (see chrome-login.ts). Google's BotGuard flags Chromium-embedded sign-in no
// matter how we spoof it, so we don't sign in inside Electron at all — real Chrome logs in, we copy
// the session, a later recording in that profile is already authenticated.
ipcMain.handle('login:open', async (_event, payload) => {
  const startUrl = String(payload?.startUrl ?? '')
  const cfg = await getConfig()
  const profileId = String(payload?.profileId ?? cfg.lastProfileId ?? 'default')
  const partition = resolvePartition(profileId, cfg.profiles)

  await setLastProfileId(profileId)
  const result = launchLoginChrome({ startUrl, partition })

  if (!result.ok) {
    throw new Error(result.error ?? 'Failed to launch Chrome')
  }

  return { success: true }
})

ipcMain.handle('recording:list', async () => {
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
  await deleteRecording(await getSessionsRoot(), runId)

  return { success: true }
})

// Copy a recording's absolute folder path to the clipboard (saves opening + copying from Explorer).
ipcMain.handle('recording:copy-path', async (_event, runId) => {
  if (typeof runId !== 'string' || runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
    throw new Error('invalid runId')
  }

  const path = join(await getSessionsRoot(), runId)

  clipboard.writeText(path)

  return { path }
})

ipcMain.handle('profiles:create', async (_event, payload) => {
  const label = String((payload as { label?: unknown })?.label ?? '')
  const chromeLogin = (payload as { chromeLogin?: unknown })?.chromeLogin === true
  const { config } = await createProfile(label, chromeLogin)

  return config
})

// Toggle a profile's chrome-login flag. id === "default" targets the built-in Default profile.
ipcMain.handle('profiles:set-chrome-login', async (_event, id, value) => {
  return setChromeLogin(String(id ?? ''), value === true)
})

// Delete a custom profile and wipe its session data. Blocked while that profile is mid-recording.
ipcMain.handle('profiles:delete', async (_event, id) => {
  const profileId = String(id ?? '')
  const partition = `persist:decoy-${profileId}`

  if (activeRecording && activeRecording.partition === partition) {
    throw new Error('That profile is in use by the active recording — stop it first.')
  }

  const config = await deleteProfile(profileId)

  await session.fromPartition(partition).clearStorageData()
  removeChromeSession(partition)

  return config
})

ipcMain.handle('recording:rename', async (_event, runId, name) => {
  if (typeof runId !== 'string' || runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
    throw new Error('invalid runId')
  }

  return renameRecording(await getSessionsRoot(), runId, String(name ?? ''))
})

ipcMain.on('recorder:toolbar-stop', () => {
  if (activeRecording) {
    activeRecording.window.close()
  }
})

ipcMain.on('recorder:toolbar-pause-toggle', () => {
  if (activeRecording) {
    activeRecording.togglePause()
  }
})

ipcMain.handle('recording:active', () => activeRecordingInfo())

// Stop & save the live recording from the control panel (mirrors the toolbar Stop).
ipcMain.handle('recording:stop', () => {
  if (activeRecording) {
    activeRecording.window.close()
  }

  return { success: true }
})

// Confirm an irreversible delete with a native modal before the renderer removes the run.

// Confirm deleting a profile — it wipes that session's cookies/logins, so warn before the renderer
// calls profiles:delete.
ipcMain.handle('profiles:confirm-delete', async (_event, label) => {
  const parent = mainWindow instanceof BaseWindow ? mainWindow : undefined
  const opts = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
    title: 'Delete profile',
    message: `Delete the “${String(label ?? 'this profile')}” profile?`,
    detail: 'This signs out and clears all cookies and stored data for this profile. This cannot be undone.',
  }
  const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)

  return { confirmed: response === 1 }
})

ipcMain.handle('config:get', () => getConfig())

ipcMain.handle('config:set-sessions-root', (_event, root) => setSessionsRoot(String(root ?? '')))

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

ipcMain.handle('config:clear-history', () => clearUrlHistory())

ipcMain.handle('config:set-filters', (_event, filters) => {
  return setFilters({
    skipResourceTypes: Array.isArray(filters?.skipResourceTypes) ? filters.skipResourceTypes.map(String) : [],
    blockHosts: Array.isArray(filters?.blockHosts) ? filters.blockHosts.map(String) : [],
  })
})

ipcMain.handle('config:reset-filters', () => resetFilters())

// --- lifecycle -------------------------------------------------------------

app.whenReady().then(() => {
  // Apply the spoofed UA to the default session too (control panel uses it).
  session.defaultSession.setUserAgent(USER_AGENT)

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
