import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// The control-panel renderer talks to the main process only through this bridge.
// Keep the surface small and serializable. (Typed view lives in renderer/bridge.ts.)
contextBridge.exposeInMainWorld('decoy', {
  startRecording: (payload: unknown) => ipcRenderer.invoke('recording:start', payload),
  openLogin: (payload: unknown) => ipcRenderer.invoke('login:open', payload),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  getActiveRecording: () => ipcRenderer.invoke('recording:active'),
  listRecordings: () => ipcRenderer.invoke('recording:list'),
  openRecording: (runId: string) => ipcRenderer.invoke('recording:open-folder', runId),
  deleteRecording: (runId: string) => ipcRenderer.invoke('recording:delete', runId),
  renameRecording: (runId: string, name: string) => ipcRenderer.invoke('recording:rename', runId, name),
  copyRecordingPath: (runId: string) => ipcRenderer.invoke('recording:copy-path', runId),

  createProfile: (label: string, chromeLogin: boolean) => ipcRenderer.invoke('profiles:create', { label, chromeLogin }),
  setProfileChromeLogin: (id: string, value: boolean) => ipcRenderer.invoke('profiles:set-chrome-login', id, value),
  deleteProfile: (id: string) => ipcRenderer.invoke('profiles:delete', id),
  confirmDeleteProfile: (label: string) => ipcRenderer.invoke('profiles:confirm-delete', label),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setSessionsRoot: (root: string) => ipcRenderer.invoke('config:set-sessions-root', root),
  pickSessionsRoot: () => ipcRenderer.invoke('config:pick-folder'),
  clearUrlHistory: () => ipcRenderer.invoke('config:clear-history'),
  setFilters: (filters: unknown) => ipcRenderer.invoke('config:set-filters', filters),
  resetFilters: () => ipcRenderer.invoke('config:reset-filters'),

  // Fires when a recording window opens, so the panel can show its live banner.
  onRecordingStarted: (cb: (info: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, info: unknown) => cb(info)

    ipcRenderer.on('recording:started', handler)

    return () => ipcRenderer.off('recording:started', handler)
  },

  // Fires as the live recording's request/websocket counts climb.
  onRecordingProgress: (cb: (counts: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, counts: unknown) => cb(counts)

    ipcRenderer.on('recording:progress', handler)

    return () => ipcRenderer.off('recording:progress', handler)
  },

  // Fires when any recording window finishes, so the list can refresh.
  onRecordingFinished: (cb: () => void) => {
    const handler = () => cb()

    ipcRenderer.on('recording:finished', handler)

    return () => ipcRenderer.off('recording:finished', handler)
  },
})
