// 启动器页面与主进程之间的桥（contextIsolation 下唯一通道）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  openInApp: () => ipcRenderer.send('open-in-app'),
  openInEdge: () => ipcRenderer.send('open-in-edge'),
  onStatus: (callback) => ipcRenderer.on('status', (_event, status) => callback(status)),
});
