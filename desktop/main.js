// Qiu_Ai_LZ 桌面启动器
// 流程：校验构建新鲜度(过期自动重建) → 复用或拉起本地服务 → 就绪后自动进入应用 → 退出时善后
// 注意：本应用不创建菜单栏——Windows 下菜单栏会吞掉 Alt 键，push-to-talk 插件依赖按住 Alt 说话。
import { app, BrowserWindow, Menu, dialog, ipcMain, screen } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const APP_NAME = 'Qiu_Ai_LZ';
const APP_ID = 'com.qiuailz.desktop';

const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.PORT || process.env.SERVER_PORT) || 3001;
const READY_TIMEOUT_MS = 60000;
const BUILD_TIMEOUT_MS = 600000;
const MTIME_TOLERANCE_MS = 3000;
// 参与新鲜度比较的源码目录/文件：任何一处比构建产物新，就先重建再启动
const SOURCE_DIRS = ['src', 'server', 'shared', 'public'];
const SOURCE_FILES = ['package.json', 'vite.config.js', 'index.html', 'tailwind.config.js', 'postcss.config.js', 'tsconfig.json'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-server', 'dist-server.next', 'release', 'coverage']);

let win = null;
let serverProc = null;
let serverUrl = null;
let quitting = false;

function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

let pendingStatus = { text: '正在启动…', level: 'info' };

function sendStatus(text, level = 'info') {
  pendingStatus = { text, level };
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send('shell-status', pendingStatus);
  }
}

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      res.resume();
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 500) return resolve(null);
        try { resolve(JSON.parse(body)); } catch { resolve({}); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, HOST);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const tester = net.createServer()
      .once('error', reject)
      .once('listening', () => {
        const { port } = tester.address();
        tester.close(() => resolve(port));
      })
      .listen(0, HOST);
  });
}

async function newestMtime(entry, state = { t: 0 }) {
  let stat;
  try {
    stat = await fsp.stat(entry);
  } catch {
    return state;
  }
  if (stat.mtimeMs > state.t) state.t = stat.mtimeMs;
  if (!stat.isDirectory()) return state;

  let entries;
  try {
    entries = await fsp.readdir(entry, { withFileTypes: true });
  } catch {
    return state;
  }
  for (const item of entries) {
    if (SKIP_DIRS.has(item.name)) continue;
    await newestMtime(path.join(entry, item.name), state);
  }
  return state;
}

async function buildIsStale() {
  const frontend = path.join(PROJECT_ROOT, 'dist', 'index.html');
  const serverEntry = path.join(PROJECT_ROOT, 'dist-server', 'server', 'index.js');
  if (!fs.existsSync(frontend) || !fs.existsSync(serverEntry)) return true;

  let newestSource = { t: 0 };
  for (const dir of SOURCE_DIRS) {
    await newestMtime(path.join(PROJECT_ROOT, dir), newestSource);
  }
  for (const file of SOURCE_FILES) {
    await newestMtime(path.join(PROJECT_ROOT, file), newestSource);
  }

  const [frontendStat, serverStat] = await Promise.all([fsp.stat(frontend), fsp.stat(serverEntry)]);
  return newestSource.t > Math.min(frontendStat.mtimeMs, serverStat.mtimeMs) + MTIME_TOLERANCE_MS;
}

function runBuild() {
  return new Promise((resolve) => {
    sendStatus('检测到源码有更新，正在重新构建（约 1 分钟）…', 'warn');
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const build = spawn(npmCmd, ['run', 'build'], { cwd: PROJECT_ROOT, windowsHide: true });
    let lastLine = '';

    const forward = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const text = line.trim();
        if (text) lastLine = text;
      }
      sendStatus(`构建中… ${lastLine.slice(0, 80)}`, 'warn');
    };
    build.stdout?.on('data', forward);
    build.stderr?.on('data', forward);

    const timer = setTimeout(() => {
      build.kill();
      resolve(false);
    }, BUILD_TIMEOUT_MS);

    build.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    build.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function startServer(port) {
  const builtEntry = path.join(PROJECT_ROOT, 'dist-server', 'server', 'index.js');
  const args = fs.existsSync(builtEntry)
    ? [builtEntry]                                            // 有构建产物就跑构建版
    : [path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
       path.join(PROJECT_ROOT, 'server', 'index.ts')];        // 否则用 tsx 跑源码

  serverProc = spawn('node', args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(port), SERVER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on('exit', (code) => {
    console.log(`[launcher] server exited, code ${code}`);
    serverProc = null;
  });
}

async function ensureServer() {
  const defaultUrl = `http://${HOST}:${DEFAULT_PORT}`;

  // 已有跑着的实例（比如另外开着 npm run dev）且版本一致就直接复用，不重复起
  const health = await ping(`${defaultUrl}/health`);
  if (health?.status === 'ok' && health.version === pkgVersion()) {
    serverUrl = defaultUrl;
    sendStatus('检测到本地服务已在运行，直接复用');
    return;
  }

  const port = (await isPortFree(DEFAULT_PORT)) ? DEFAULT_PORT : await freePort();
  serverUrl = `http://${HOST}:${port}`;
  sendStatus(`正在启动本地服务（端口 ${port}）…`);
  startServer(port);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await ping(`${serverUrl}/health`))?.status === 'ok') return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('本地服务启动超时');
}

function killServerTree() {
  const proc = serverProc;
  if (!proc) return;
  serverProc = null;
  if (process.platform === 'win32') {
    // /T 连同子进程（node-pty 终端等）一起结束
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { proc.kill(); } catch { /* 已退出 */ }
  }
}

async function enterApp() {
  if (!win || !serverUrl) return;
  try {
    await win.loadURL(serverUrl);
  } catch {
    // 页面自身的加载错误由应用内处理；这里只关心导航是否完成
  }
  // Windows 后台启动偶发整页黑屏（渲染进程不重绘），导航完成后强制重绘一次
  win.webContents.invalidate();
  win.show();
  win.focus();
}

function getWindowIconPath() {
  return process.platform === 'darwin'
    ? path.join(PROJECT_ROOT, 'desktop', 'assets', 'logo-macos.png')
    : path.join(PROJECT_ROOT, 'desktop', 'assets', 'logo-windows.ico');
}

function getWorkAreaBounds() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.floor(workArea.width * 2 / 3);
  const height = Math.floor(workArea.height * 2 / 3);
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...getWorkAreaBounds(),
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#141414',
    title: APP_NAME,
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'launcher.html'));

  // 启动页脚本就绪前发出的状态会丢，页面每次加载完成后补发最后一条
  win.webContents.on('did-finish-load', () => {
    if (pendingStatus && !win.isDestroyed()) {
      win.webContents.send('shell-status', pendingStatus);
    }
  });

  // 无菜单栏时补齐基本快捷键：F5/Ctrl+R 刷新；未打包时 F12 开发者工具
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'f5' || (input.control && key === 'r')) {
      event.preventDefault();
      win.webContents.reload();
    } else if (key === 'f12' && !app.isPackaged) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    app.setName(APP_NAME);
    if (process.platform === 'win32') {
      app.setAppUserModelId(APP_ID);
    }
    // 关键：不创建菜单栏，否则 Windows 会把 Alt 键拿去触发菜单，按住 Alt 说话会失灵
    Menu.setApplicationMenu(null);

    ipcMain.handle('qiu-desktop:pick-folder', async () => {
      const result = await dialog.showOpenDialog(win, {
        title: '选择工作区文件夹',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    });

    createWindow();

    try {
      if (await buildIsStale()) {
        const ok = await runBuild();
        if (!ok) {
          sendStatus('自动构建失败，尝试用源码模式直接启动…', 'warn');
        }
      } else {
        sendStatus('构建产物已是最新');
      }

      await ensureServer();
      sendStatus('已就绪，正在进入应用…', 'ready');
      setTimeout(() => enterApp(), 300);
    } catch (error) {
      console.error(error);
      sendStatus(`启动失败：${error.message}`, 'failed');
    }
  });
}

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  // 只杀自己拉起来的服务；复用的别人的实例不动
  killServerTree();
});
