const { contextBridge, ipcRenderer } = require('electron')

// The control-panel renderer talks to the main process only through this
// bridge. Keep the surface small and serializable.
contextBridge.exposeInMainWorld('decoy', {
  startRecording: (payload) => ipcRenderer.invoke('recording:start', payload),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  getActiveRecording: () => ipcRenderer.invoke('recording:active'),
  listRecordings: () => ipcRenderer.invoke('recording:list'),
  openRecording: (runId) => ipcRenderer.invoke('recording:open-folder', runId),
  confirmDelete: (label) => ipcRenderer.invoke('recording:confirm-delete', label),
  deleteRecording: (runId) => ipcRenderer.invoke('recording:delete', runId),
  renameRecording: (runId, name) => ipcRenderer.invoke('recording:rename', runId, name),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setSessionsRoot: (root) => ipcRenderer.invoke('config:set-sessions-root', root),
  pickSessionsRoot: () => ipcRenderer.invoke('config:pick-folder'),
  clearUrlHistory: () => ipcRenderer.invoke('config:clear-history'),
  setFilters: (filters) => ipcRenderer.invoke('config:set-filters', filters),
  resetFilters: () => ipcRenderer.invoke('config:reset-filters'),

  // Fires when a recording window opens, so the panel can show its live banner.
  onRecordingStarted: (cb) => {
    const handler = (_e, info) => cb(info)

    ipcRenderer.on('recording:started', handler)

    return () => ipcRenderer.off('recording:started', handler)
  },

  // Fires as the live recording's request/websocket counts climb.
  onRecordingProgress: (cb) => {
    const handler = (_e, counts) => cb(counts)

    ipcRenderer.on('recording:progress', handler)

    return () => ipcRenderer.off('recording:progress', handler)
  },

  // Fires when any recording window finishes, so the list can refresh.
  onRecordingFinished: (cb) => {
    const handler = () => cb()

    ipcRenderer.on('recording:finished', handler)

    return () => ipcRenderer.off('recording:finished', handler)
  },
})
