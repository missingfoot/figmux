const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('figmux', {
  onTabs: (callback) => ipcRenderer.on('tabs', (_event, state) => callback(state)),
  activate: (id) => ipcRenderer.send('tab:activate', id),
  close: (id) => ipcRenderer.send('tab:close', id),
  newTab: () => ipcRenderer.send('tab:new'),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
});
