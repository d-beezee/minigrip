// Electron main process: runs the MiniGrip API in-process on a random localhost port
// (protected by a per-launch token) and opens it in a window.
import { app, BrowserWindow, Menu, shell, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV = !app.isPackaged && process.argv.includes('--dev');
const DEV_URL = 'http://localhost:5173';

if (!app.requestSingleInstanceLock()) app.quit();

process.env.MINIGRIP_DATA ||= path.join(app.getPath('userData'), 'data');
const token = crypto.randomBytes(24).toString('hex');
let server;
let win;

function sendMenu(action) {
  win?.webContents.send('menu', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Data Source…', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-connection') },
        { label: 'New Console', accelerator: 'CmdOrCtrl+T', click: () => sendMenu('new-console') },
        { label: 'Close Console', accelerator: 'CmdOrCtrl+W', click: () => sendMenu('close-console') },
        { type: 'separator' },
        { label: 'Run SQL Script…', click: () => sendMenu('run-script') },
        { label: 'Query History', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('history') },
        { type: 'separator' },
        { label: 'Open Data Folder', click: () => shell.openPath(process.env.MINIGRIP_DATA) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Query',
      submenu: [
        { label: 'Run Statement', accelerator: 'CmdOrCtrl+Enter', registerAccelerator: false, click: () => sendMenu('run') },
        { label: 'Run All', accelerator: 'CmdOrCtrl+Shift+Enter', registerAccelerator: false, click: () => sendMenu('run-all') },
        { label: 'Cancel', click: () => sendMenu('cancel') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function loadWithRetry(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      await win.loadURL(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250)); // Vite dev server still starting
    }
  }
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#1e1f22',
    title: 'MiniGrip',
    icon: path.join(here, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--minigrip-token=${token}`],
    },
  });
  win.once('ready-to-show', () => win.show());

  // Links open in the system browser, never in a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${server.port}`) && !url.startsWith(DEV_URL)) e.preventDefault();
  });

  await loadWithRetry(DEV ? DEV_URL : `http://127.0.0.1:${server.port}/`);
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  const { startServer } = await import('../server/index.js');
  try {
    // dev: fixed port so the Vite proxy can reach it
    server = await startServer({ port: DEV ? 4870 : 0, token, distDir: path.join(here, '..', 'dist') });
  } catch (e) {
    dialog.showErrorBox('MiniGrip', 'Cannot start the internal server:\n' + e.message);
    app.exit(1);
    return;
  }

  // Exports: always ask where to save, starting in Downloads.
  session.defaultSession.on('will-download', (e, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });

  ipcMain.handle('pick-file', async (e, opts = {}) => {
    const r = await dialog.showOpenDialog(win, {
      title: opts.title || 'Choose file',
      defaultPath: (opts.defaultPath || '~').replace(/^~/, app.getPath('home')),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  buildMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  await server.close().catch(() => {}); // close DB sessions and SSH tunnels
  app.quit();
});
