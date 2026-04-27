const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('elevenexSettings', {
  load: () => ipcRenderer.invoke('elevenex-settings:load'),
  save: (settings) => ipcRenderer.invoke('elevenex-settings:save', settings),
});
