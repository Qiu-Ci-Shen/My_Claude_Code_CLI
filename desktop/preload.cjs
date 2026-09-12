// 启动器页面与主进程之间的桥（contextIsolation 下唯一通道）
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
    openFolder: (dirPath) => ipcRenderer.invoke('qiu-desktop:open-folder', dirPath),
    // 浏览器 File 对象 → 本机磁盘路径（Electron 30+ 官方 API）；剪贴板粘贴等无磁盘来源的文件返回空串
    getPathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    // 用系统默认程序打开文件（Word/PPT/PDF 等）；成功返回空串，失败返回错误描述
    openFile: (filePath) => ipcRenderer.invoke('qiu-desktop:open-file', filePath),
  });
}
