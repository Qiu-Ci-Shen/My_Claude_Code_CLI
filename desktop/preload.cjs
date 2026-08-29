// 启动器页面与主进程之间的桥（contextIsolation 下唯一通道）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qiuDesktopShell', {
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('shell-status', listener);
    return () => ipcRenderer.removeListener('shell-status', listener);
  },
});

// 仅对本机来源暴露文件系统能力（应用内加载的 UI 页面）
const loc = window.location;
const isLocalOrigin =
  loc.protocol === 'file:' ||
  (loc.protocol === 'http:' && (loc.hostname === '127.0.0.1' || loc.hostname === 'localhost'));

if (isLocalOrigin) {
  contextBridge.exposeInMainWorld('qiuDesktopFs', {
    pickFolder: () => ipcRenderer.invoke('qiu-desktop:pick-folder'),
  });
}
