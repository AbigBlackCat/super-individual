const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('superIndividual', {
  chooseDirectory: () => ipcRenderer.invoke('si:choose-directory'),
  openPath: value => ipcRenderer.invoke('si:open-path', value),
  runtimeStatus: () => ipcRenderer.invoke('si:runtime-status'),
});
