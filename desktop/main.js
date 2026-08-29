// Qiu_Ai_LZ 极简桌面启动器
// 职责只有三个：拉起本地服务 → 让你选「应用内打开 / Edge 浏览器打开」→ 退出时善后
import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.PORT || process.env.SERVER_PORT) || 3001;
const READY_TIMEOUT_MS = 60000;

let win = null;
let serverProc = null;
let serverUrl = null;
let serverReady = false;
let pendingAction = null; // 用户点了按钮但服务还没起来时，记住动作

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
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
  // 已有跑着的实例（比如你另外开了 npm run dev）就直接复用，不重复起
  const existingUrl = `http://${HOST}:${DEFAULT_PORT}`;
  if (await ping(`${existingUrl}/health`)) {
    serverUrl = existingUrl;
    return;
  }
  const port = (await isPortFree(DEFAULT_PORT)) ? DEFAULT_PORT : await freePort();
  serverUrl = `http://${HOST}:${port}`;
  startServer(port);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await ping(`${serverUrl}/health`)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('本地服务启动超时');
}

function openInApp() {
  if (!win || !serverUrl) return;
  win.setResizable(true);
  win.setSize(1440, 900);
  win.center();
  win.loadURL(serverUrl);
}

function openInEdge() {
  if (!serverUrl) return;
  // Windows 下强制用 Edge；失败则退回系统默认浏览器
  const edge = spawn('cmd', ['/c', 'start', '', `microsoft-edge:${serverUrl}`], {
    detached: true,
    stdio: 'ignore',
  });
  edge.on('error', () => import('electron').then(({ shell }) => shell.openExternal(serverUrl)));
  edge.unref();
  win?.webContents.send('status', 'edge-opened');
}

function handleAction(action) {
  if (!serverReady) {
    pendingAction = action; // 服务没起好，先记着，起好后自动执行
    return;
  }
  if (action === 'app') openInApp();
  if (action === 'edge') openInEdge();
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 320,
    resizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#141414',
    title: 'Qiu_Ai_LZ',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'launcher.html'));
}

app.whenReady().then(async () => {
  ipcMain.on('open-in-app', () => handleAction('app'));
  ipcMain.on('open-in-edge', () => handleAction('edge'));

  createWindow();

  try {
    await ensureServer();
    serverReady = true;
    win?.webContents.send('status', 'ready');
    if (pendingAction) {
      const action = pendingAction;
      pendingAction = null;
      handleAction(action);
    }
  } catch (error) {
    console.error(error);
    win?.webContents.send('status', 'failed');
  }
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  // 只杀自己拉起来的服务；复用的别人的实例不动
  if (serverProc) serverProc.kill();
});
