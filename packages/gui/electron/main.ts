import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { registerBridge } from './sync-bridge.js';
import { loadAppState } from './state-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const DEV_URL = 'http://localhost:5173';
const RENDERER_INDEX = join(__dirname, '..', 'dist-renderer', 'index.html');

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (isDev) {
    let attempts = 0;
    for (;;) {
      try {
        await window.loadURL(DEV_URL);
        return;
      } catch (err) {
        if (++attempts > 60) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  await window.loadFile(RENDERER_INDEX);
}

async function pickFolder(window: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(window, {
    title: 'Select content folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const chosen = result.filePaths[0];
  if (!chosen) return null;
  try {
    await fs.access(chosen);
  } catch {
    return null;
  }
  return chosen;
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    backgroundColor: '#101418',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  ipcMain.handle('wpsync:pickFolder', () => pickFolder(window));
  registerBridge(window);

  await loadRenderer(window);
  if (isDev) window.webContents.openDevTools({ mode: 'detach' });
  return window;
}

app.whenReady().then(async () => {
  // Restoring last-used rootDir is just a hint to the renderer; the renderer
  // calls checkConfig() before deciding which screen to show.
  await loadAppState();
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('wpsync:lastRootDir', async () => {
  const s = await loadAppState();
  return s.rootDir;
});
