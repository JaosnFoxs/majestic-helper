const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('state'),
  refresh: () => ipcRenderer.invoke('refresh'),
  saveSettings: (s) => ipcRenderer.invoke('settings', s),
  savePins: (p) => ipcRenderer.invoke('pins', p),
  pathOf: (f) => webUtils.getPathForFile(f),
  updateZip: (p) => ipcRenderer.invoke('update-zip', p),
  updateNow: () => ipcRenderer.invoke('update-now'),
  openData: () => ipcRenderer.send('open-data'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  hide: () => ipcRenderer.send('hide'),
  quit: () => ipcRenderer.send('quit'),
  open: (u) => ipcRenderer.send('open', u),
  on: (ch, cb) => ipcRenderer.on(ch, (_, d) => cb(d)),
});
