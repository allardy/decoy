import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('recorderToolbar', {
  stop: () => ipcRenderer.send('recorder:toolbar-stop'),
  togglePause: () => ipcRenderer.send('recorder:toolbar-pause-toggle'),
})
