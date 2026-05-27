import { app, BaseWindow, session, WebContentsView, type WebContents } from 'electron'
import { join } from 'node:path'

import { writeHarForRun } from './har.js'
import { formatRunId } from './naming.js'
import { Recorder } from './recorder.js'
import { ensureRunDir, ensureSessionsRoot } from './storage.js'
import type { FilterConfig } from './types.js'

const TOOLBAR_HEIGHT = 56
const REUSE_PARTITION = 'persist:decoy'

export interface RecordingHandle {
  runId: string
  runDir: string
  partition: string
  window: BaseWindow
  recorder: Recorder
  label: string
  startUrl: string
  togglePause: () => void
}

export interface CreateRecorderOptions {
  label: string
  startUrl: string
  reuseSession: boolean
  captureAll: boolean
  filters: FilterConfig
  autoRecord: boolean
  exportHar: boolean
  toolbarUrl: string
  sessionsRoot: string
  userAgent: string
  onProgress: (counts: { requests: number; websockets: number }) => void
  onClosed: (handle: RecordingHandle) => void
}

/** F12 / Ctrl+Shift+I that yields the recorder's debugger to DevTools first. */
function bindDevToolsWithHandoff(contents: WebContents, recorder: Recorder): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }

    const isF12 = input.key === 'F12'
    const isCtrlShiftI = (input.control || input.meta) && input.shift && (input.key === 'I' || input.key === 'i')

    if (!isF12 && !isCtrlShiftI) {
      return
    }

    event.preventDefault()

    if (contents.isDevToolsOpened()) {
      contents.closeDevTools()
    } else {
      recorder.suspendForDevTools(contents)
      contents.openDevTools({ mode: 'detach' })
    }
  })
}

export async function createRecorderWindow(opts: CreateRecorderOptions): Promise<RecordingHandle> {
  await ensureSessionsRoot(opts.sessionsRoot)
  const runId = formatRunId(new Date(), opts.label)
  const runDir = await ensureRunDir(opts.sessionsRoot, runId)

  const partition = opts.reuseSession ? REUSE_PARTITION : `recording-${runId}`
  const ses = session.fromPartition(partition)

  ses.setUserAgent(opts.userAgent)

  // Match real Chrome's client hints + language so Chrome-only sniffers load.
  // Keep these versions in sync with USER_AGENT (electron.mjs) and popup-preload.cjs.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }

    delete headers['X-Requested-With']
    headers['Accept-Language'] = 'en-US,en;q=0.9'
    headers['Sec-Ch-Ua'] = '"Chromium";v="140", "Not(A:Brand";v="24", "Google Chrome";v="140"'
    headers['Sec-Ch-Ua-Mobile'] = '?0'
    headers['Sec-Ch-Ua-Platform'] = '"Windows"'
    callback({ requestHeaders: headers })
  })

  const popupPreload = join(app.getAppPath(), 'popup-preload.cjs')

  const window = new BaseWindow({
    width: 1280,
    height: 920,
    title: `Decoy — ${opts.label}`,
    backgroundColor: '#18181b',
    icon: join(app.getAppPath(), 'public/decoy-icon.png'),
  })

  const toolbar = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      preload: join(app.getAppPath(), 'src/main/recording/toolbar-preload.cjs'),
    },
  })
  const site = new WebContentsView({
    webPreferences: {
      session: ses,
      // contextIsolation:false lets popup-preload override navigator.userAgentData
      // in the main world so client-hints sniffers (Slack et al.) see Google Chrome.
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      preload: popupPreload,
    },
  })

  window.contentView.addChildView(toolbar)
  window.contentView.addChildView(site)

  const layout = () => {
    const { width, height } = window.getContentBounds()

    toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT })
    site.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT),
    })
  }

  layout()
  window.on('resize', layout)

  const recorder = new Recorder({
    runDir,
    captureAll: opts.captureAll,
    filters: opts.filters,
    autoRecord: opts.autoRecord,
    onProgress: (counts) => {
      opts.onProgress(counts)
      void toolbar.webContents
        .executeJavaScript(`window.__recorderSetCount(${counts.requests}, ${counts.websockets})`)
        .catch(() => {})
    },
  })

  let paused = !opts.autoRecord
  const applyPaused = () => {
    recorder.setPaused(paused)
    void toolbar.webContents.executeJavaScript(`window.__recorderSetPaused(${paused})`).catch(() => {})
  }

  // Capture popups / child windows. They open on the same partition (auth carries
  // over), get the UA spoof, F12 handoff, and are attached to the same recorder so
  // their traffic lands in this run. Nested popups are wired recursively.
  const wireChildWindows = (contents: WebContents) => {
    contents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1100,
        height: 820,
        webPreferences: {
          partition,
          contextIsolation: false,
          nodeIntegration: false,
          sandbox: false,
          preload: popupPreload,
        },
      },
    }))
    contents.on('did-create-window', (childWindow) => {
      const child = childWindow.webContents

      child.setUserAgent(opts.userAgent)
      recorder.attachTo(child, 'popup')
      bindDevToolsWithHandoff(child, recorder)
      child.on('did-navigate', (_e, url) => pushUrl(_e, url))
      wireChildWindows(child)
    })
  }

  const pushUrl = (_e: unknown, url: string) => {
    void toolbar.webContents.executeJavaScript(`window.__recorderSetUrl(${JSON.stringify(url)})`).catch(() => {})
  }

  bindDevToolsWithHandoff(site.webContents, recorder)
  // F12 on the toolbar pane is useless — redirect it to the site view.
  toolbar.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }

    const isF12 = input.key === 'F12'
    const isCtrlShiftI = (input.control || input.meta) && input.shift && (input.key === 'I' || input.key === 'i')

    if (!isF12 && !isCtrlShiftI) {
      return
    }

    event.preventDefault()

    if (site.webContents.isDevToolsOpened()) {
      site.webContents.closeDevTools()
    } else {
      recorder.suspendForDevTools(site.webContents)
      site.webContents.openDevTools({ mode: 'detach' })
    }
  })

  site.webContents.on('did-navigate', pushUrl)
  site.webContents.on('did-navigate-in-page', pushUrl)
  wireChildWindows(site.webContents)

  // Attach the recorder BEFORE the first navigation so nothing is missed.
  recorder.attachTo(site.webContents, 'page')

  const toolbarQuery = `?label=${encodeURIComponent(opts.label)}${opts.captureAll ? '&all=1' : ''}`

  await toolbar.webContents.loadURL(`${opts.toolbarUrl}${toolbarQuery}`)
  await site.webContents.loadURL(opts.startUrl)

  applyPaused() // sync the toolbar badge with the initial paused state

  const handle: RecordingHandle = {
    runId,
    runDir,
    partition,
    window,
    recorder,
    label: opts.label,
    startUrl: opts.startUrl,
    togglePause: () => {
      paused = !paused
      applyPaused()
    },
  }

  let stopping = false

  window.on('close', (event) => {
    if (stopping) {
      return
    }

    event.preventDefault()
    stopping = true
    void recorder
      .stop({ label: opts.label, startUrl: opts.startUrl, partition })
      .then(async () => {
        if (opts.exportHar) {
          await writeHarForRun(runDir).catch((err) => console.error('[recorder] HAR export failed:', err))
        }
      })
      .catch((err) => console.error('[recorder] stop failed:', err))
      .finally(() => {
        opts.onClosed(handle)

        try {
          window.destroy()
        } catch {
          // already destroyed
        }
      })
  })

  return handle
}
