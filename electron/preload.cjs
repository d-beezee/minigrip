// Exposes a minimal, safe bridge to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

const tokenArg = process.argv.find((a) => a.startsWith('--minigrip-token='));

contextBridge.exposeInMainWorld('minigrip', {
  electron: true,
  platform: process.platform,
  token: tokenArg ? tokenArg.split('=')[1] : null,
  pickFile: (opts) => ipcRenderer.invoke('pick-file', opts),
  onMenu(cb) {
    const h = (_e, action) => cb(action);
    ipcRenderer.on('menu', h);
    return () => ipcRenderer.removeListener('menu', h);
  },
});
