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
  // Two paths: create + load, or reload-if-already-attached. EITHER way we
  // notify the renderer at the end. Before this fix, the reload branch
  // silently dropped the notification, which meant if the URL ever
  // changed (e.g., dev server restarted on a different port) the renderer
  // kept showing the old URL state.
  if (previewView) {
    void previewView.webContents.loadURL(targetUrl);
  } else {
    previewView = new WebContentsView();
    mainWindow.contentView.addChildView(previewView);
    void previewView.webContents.loadURL(targetUrl);
    layoutPreview();
  }
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
// Reserve space for the preview bar (Desktop/Phone tabs + status pill) at
// the top of the preview column. Comes off the top of the WebContentsView.
const PREVIEW_BAR_HEIGHT = 44;
// Reserve space for the save-points timeline at the bottom (Phase 6
// follow-up). Comes off the bottom of the WebContentsView.
const TIMELINE_HEIGHT = 64;
// Phone preview width — the design's mobile mode. WebContentsView gets
// constrained to this width, centered in the preview column, and the
// renderer's CSS adds a subtle phone-frame border around the stage.
const PHONE_WIDTH = 390;

type PreviewDevice = 'desktop' | 'phone';
let previewDevice: PreviewDevice = 'desktop';

function setPreviewDevice(device: PreviewDevice): void {
  previewDevice = device;
  layoutPreview();
}

/**
 * Hide / show the preview WebContentsView without tearing it down.
 *
 * WebContentsView is a NATIVE overlay — it paints on top of the renderer's
 * HTML regardless of CSS z-index. When the renderer shows a modal-veil, the
 * preview view still covers the lower 90% of the window, making the modal
 * effectively invisible. Setting `visible=false` (via a zero-sized bounds
 * rect — Electron 42's WebContentsView has no direct `setVisible`) parks
 * the native paint area off-screen until the modal closes.
 *
 * The web contents stays loaded so the project's dev server connection
 * isn't churned every time a modal opens.
 */
function setPreviewVisible(visible: boolean): void {
  if (!mainWindow || !previewView) return;
  if (visible) {
    layoutPreview();
  } else {
    // Park off-screen. setBounds with width:0/height:0 stops the paint.
    previewView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
}

function layoutPreview(): void {
  if (!mainWindow || !previewView) return;
  const { width, height } = mainWindow.getContentBounds();
  // The WebContentsView always lives inside the preview column (right of
  // the chat) AND below the preview bar (Desktop/Phone tabs). In phone
  // mode the view is also constrained to PHONE_WIDTH and centered.
  const colLeft = CHAT_COL_WIDTH;
  const colRight = width;
  const stageTop = TOPBAR_HEIGHT + PREVIEW_BAR_HEIGHT;
  const stageBottom = height - TIMELINE_HEIGHT;
  let x = colLeft;
  let viewWidth = Math.max(0, colRight - colLeft);

  if (previewDevice === 'phone') {
    // Center a PHONE_WIDTH-wide view inside the column. Falls back to the
    // full column if the column is narrower than PHONE_WIDTH (small windows).
    const fits = viewWidth > PHONE_WIDTH;
    if (fits) {
      const pad = Math.floor((viewWidth - PHONE_WIDTH) / 2);
      x = colLeft + pad;
      viewWidth = PHONE_WIDTH;
    }
  }

  previewView.setBounds({
    x,
    y: stageTop,
    width: viewWidth,
    height: Math.max(0, stageBottom - stageTop),
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
    setPreviewVisible,
    setPreviewDevice,
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
