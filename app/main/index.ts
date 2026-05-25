import { app, BrowserWindow, ipcMain, WebContentsView } from 'electron';
import * as path from 'node:path';
import { applyPathShim } from './path-shim.js';
import { registerIpcHandlers } from './ipc.js';
import { Services } from './services.js';
import { startLocalDdb, type LocalDdb } from './dynalite/server.js';

applyPathShim({ resourcesPath: process.resourcesPath });

// `__filename` / `__dirname` are injected by the esbuild banner — don't
// redeclare them here or the emitted ESM bundle will have duplicate consts.
// See scripts/build-electron-main.ts.

let mainWindow: BrowserWindow | null = null;
let previewView: WebContentsView | null = null;
let localDdb: LocalDdb | undefined;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Keep the WebContentsView in sync with window dimensions. Without this,
  // resizing the window leaves the preview pinned to its initial bounds.
  mainWindow.on('resize', () => layoutPreview());
}

function attachPreview(targetUrl: string): void {
  if (!mainWindow) return;
  if (previewView) {
    void previewView.webContents.loadURL(targetUrl);
    return;
  }
  previewView = new WebContentsView();
  mainWindow.contentView.addChildView(previewView);
  void previewView.webContents.loadURL(targetUrl);
  layoutPreview();
  mainWindow.webContents.send('preview:url', targetUrl);
}

/**
 * Tear down the WebContentsView when the user navigates away from a project
 * (e.g. clicks the back-to-projects button). Without this, the native view
 * stays painted over the right pane while the React shell swaps to the
 * onboarding wizard — looks like the layout broke but the app kept running.
 */
function detachPreview(): void {
  if (!mainWindow || !previewView) return;
  mainWindow.contentView.removeChildView(previewView);
  // Destroy the underlying web contents so the dev server isn't kept warm
  // by an unseen browser session.
  previewView.webContents.close();
  previewView = null;
  mainWindow.webContents.send('preview:url', '');
}

// Layout constants matching the renderer CSS:
//   .shell  grid-template-rows: 52px 1fr   → top bar
//   .main   grid-template-columns: 380px 1fr → chat | preview
// Keep these in sync with sprout.css if either changes. The renderer could
// `postMessage` measured bounds for true accuracy, but for v1 the constants
// are fine and easier to reason about.
const TOPBAR_HEIGHT = 52;
const CHAT_COL_WIDTH = 380;

function layoutPreview(): void {
  if (!mainWindow || !previewView) return;
  const { width, height } = mainWindow.getContentBounds();
  const x = CHAT_COL_WIDTH;
  const y = TOPBAR_HEIGHT;
  previewView.setBounds({
    x,
    y,
    width: Math.max(0, width - x),
    height: Math.max(0, height - y),
  });
}

app.whenReady().then(async () => {
  // Boot the embedded local DynamoDB before anything spawns. Setting the
  // SPROUT_DYNALITE_ENDPOINT env var here makes it visible to dev-server.ts
  // when it builds the env for `npm run dev` subprocesses, so user code
  // using `new DynamoDBClient({})` transparently hits dynalite.
  try {
    localDdb = await startLocalDdb({
      dataPath: path.join(app.getPath('userData'), 'sprout-ddb'),
    });
    process.env.SPROUT_DYNALITE_ENDPOINT = localDdb.endpoint;
    // eslint-disable-next-line no-console
    console.log(`local DDB ready at ${localDdb.endpoint} (data: ${localDdb.dataPath})`);
  } catch (err) {
    // Non-fatal: the desktop still works without DDB, user projects that
    // touch DynamoDB will just see network errors.
    console.warn('local DDB failed to start — projects that use DynamoDB will fail locally:', err);
  }

  createWindow();

  const services = new Services({
    mainWindow: () => mainWindow,
    attachPreview,
    detachPreview,
  });
  await services.init();
  registerIpcHandlers(ipcMain, services.api());

  mainWindow?.on('resize', layoutPreview);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (!localDdb) return;
  event.preventDefault();
  try { await localDdb.stop(); } catch { /* ignore — quitting anyway */ }
  localDdb = undefined;
  app.quit();
});
