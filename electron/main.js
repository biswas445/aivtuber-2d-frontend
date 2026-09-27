/**
 * Electron main process: a borderless, transparent, always-on-top overlay
 * window (airi-vtuber style) that hosts the Live2D Cubism companion.
 *
 * - The window is click-through by default; the renderer hit-tests the character
 *   and toggles interactivity over IPC, so clicks on empty space fall through
 *   to whatever app is underneath.
 * - Model files are served over a custom `vtuber-model://` protocol so the
 *   renderer can fetch them in both dev and packaged builds.
 * - Some shipped models have mojibake filenames that don't match the paths
 *   their own model3.json references (a broken archive extraction), so the
 *   protocol resolves requested paths FUZZILY: exact match first, then a
 *   segment-by-segment walk matching directory entries by extension and digit
 *   skeleton (mojibake corruption preserves ASCII digits and punctuation, so
 *   "1208+e++1-12.20 - ¦»+¡.moc3" resolves from the referenced
 *   "1208阮梅1-12.20 - 动画.moc3" — same digits, same extension).
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  protocol,
  net,
  Tray,
  Menu,
  nativeImage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const MODELS_DIR = path.resolve(__dirname, '..', '..', 'character_models');
const MODEL_SCHEME = 'vtuber-model';
const WINDOW_W = 630;
const WINDOW_H = 840;
// The renderer's fit math cannot work below this (it skips degenerate
// viewports); a floor keeps the window from being parked there. The edit
// mode's resize handles enforce the same minimums in the renderer.
const MIN_WIN_W = 160;
const MIN_WIN_H = 200;

/* ------------------------------------------------------ error visibility ---
 * An always-on overlay that fails SILENTLY is the worst failure mode: one
 * uncaught exception in the main process and the companion just stops, with
 * no on-screen trace and often a single hidden console line. These handlers
 * log loudly to the console AND append to a persistent error.log in userData,
 * so a crash is visible and diagnosable after the fact. Recovery is
 * best-effort: an uncaughtException in the main process doesn't kill the
 * always-on overlay (a renderer crash is handled separately via
 * render-process-gone, which auto-reloads).
 */
function logUnexpected(where, err) {
  const msg = err && err.stack ? err.stack : String(err);
  console.error(`[${where}] ${msg}`);
  try {
    const dir = app.isReady() ? app.getPath('userData') : null;
    if (dir) {
      fs.appendFileSync(
        path.join(dir, 'error.log'),
        `\n${new Date().toISOString()} [${where}]\n${msg}\n`,
      );
    }
  } catch {
    /* best-effort — never let logging itself crash */
  }
}

process.on('uncaughtException', (err) => logUnexpected('uncaughtException', err));
process.on('unhandledRejection', (reason) => logUnexpected('unhandledRejection', reason));

let win = null;
let chatWin = null;
let tray = null;
let dragOffset = null;

const state = {
  x: null,
  y: null,
  w: WINDOW_W,
  h: WINDOW_H,
  pinned: true,
  trackMouse: true, // stream the global cursor position to the renderer
  model: null, // rel path of the active .model3.json file
  // Character size multiplier (bigger/smaller toolbar buttons, 0.4-2.5).
  // Persisted like every other user preference so a chosen size survives
  // app restarts.
  scaleMul: 1,
  // Character offset inside the window, fractions of the window size
  // (survives window resizes). The window itself is the container the
  // character is fitted into — resizing it re-fits her live.
  charOffset: { x: 0, y: 0 },
};

// Chat panel window state (persisted separately from the character overlay,
// same save-file). The panel embeds the official BotRix multistream widget
// (the exact page an OBS browser source loads) when a widget URL is
// configured. Panel default: hidden until the user enables it.
const chatState = {
  x: null,
  y: null,
  w: 340,
  h: 480,
  pinned: true,
  transparent: true,
  open: false, // remember across restarts whether the panel was shown
};

// Chat messages themselves are NEVER stored anywhere: no buffer, no disk,
// no database — they exist only inside the panel window's DOM while it is
// open, and die with it when it closes.

// Edit mode is session-only: always start with the overlay locked.
let editMode = 'off'; // 'off' | 'container' | 'character'

/* ------------------------------------------------------------------ state */

function stateFile() {
  return path.join(app.getPath('userData'), 'overlay-state.json');
}

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    Object.assign(state, saved);
    // Sanitize the loaded scale multiplier: hand-edited/corrupt state must
    // not wedge the renderer with NaN (the fit multiplies by it).
    if (!Number.isFinite(state.scaleMul) || state.scaleMul < 0.4 || state.scaleMul > 2.5) {
      state.scaleMul = 1;
    }
    // Window geometry: `typeof NaN === 'number'` passes a plain typeof
    // check, and a BrowserWindow built with NaN bounds ends up at an
    // arbitrary/clamped position or fails to size — coerce anything
    // non-finite back to the boot constants.
    for (const key of ['x', 'y', 'w', 'h']) {
      if (!Number.isFinite(Number(state[key]))) state[key] = null;
    }
    if (state.w !== null) state.w = Math.max(MIN_WIN_W, Math.round(state.w));
    if (state.h !== null) state.h = Math.max(MIN_WIN_H, Math.round(state.h));
    // A model saved by an older version pointed at a .vrm — drop it so the
    // scan picks a fresh default.
    if (typeof state.model === 'string' && !state.model.endsWith('.model3.json')) {
      state.model = null;
    }
    // Chat panel state rides in the same file under its own key.
    if (saved.chat && typeof saved.chat === 'object') {
      Object.assign(chatState, saved.chat);
      // Same NaN guard for the chat panel's geometry (its window has its
      // own minimums; non-finite values fall back to the defaults).
      for (const key of ['x', 'y', 'w', 'h']) {
        if (!Number.isFinite(Number(chatState[key]))) chatState[key] = null;
      }
      chatState.pinned = Boolean(chatState.pinned);
      chatState.transparent = chatState.transparent !== false;
      chatState.open = Boolean(chatState.open);
    }
  } catch {
    /* first run */
  }
}

let saveTimer = null;
function writeState() {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ ...state, chat: chatState }, null, 2));
  } catch (err) {
    console.error('[state] failed to save:', err.message);
  }
}
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeState();
  }, 250);
}

/* ----------------------------------------------------------------- models */

function scanModels() {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.toLowerCase().endsWith('.model3.json')) {
        found.push({
          name: entry.name.replace(/\.model3\.json$/i, ''),
          rel: path.relative(MODELS_DIR, full).split(path.sep).join('/'),
        });
      }
    }
  };
  walk(MODELS_DIR);
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

function modelUrl(rel) {
  return `${MODEL_SCHEME}://local/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/* --------------------------------------------- fuzzy path resolution ---
 * Some shipped models were extracted from archives with a broken encoding,
 * so their files have mojibake names while the model3.json INSIDE references
 * the original proper-Unicode paths. Requested path → resolved file:
 *   1. exact match (the common case)
 *   2. fuzzy walk, one path segment at a time: candidates with the same
 *      extension (files) / directories, matched by digit skeleton — the
 *      sequence of digit groups — plus special-cases for Live2D's
 *      `texture_NN` pages and `*.NNNN` texture directories.
 * Resolutions are cached: every asset of every model resolves at most once.
 */

const fuzzyCache = new Map(); // decoded rel path -> abs path (or null = 404)

/** Digit groups of a name, joined: "file12_3.png" -> "12,3". Mojibake
 * corruption preserves ASCII, so the referenced and on-disk names share
 * their digit skeleton even when every letter looks different. */
function digitSkeleton(name) {
  return (name.match(/\d+/g) || []).join(',');
}

/** The ASCII tail of a filename: extension plus any numeric suffix glued
 * to the base ("x.physics3.json" -> ".physics3.json", "tex_04.png" ->
 * ".png"). Mojibake corruption preserves ASCII punctuation, so the tail
 * survives even when the base is destroyed — "animation.physics3.json"
 * and "¦»+¡.physics3.json" share the exact tail ".physics3.json". This
 * disambiguates files whose digit skeletons are identical (cdi3, model3,
 * physics3, vtube all live in the same model directory). */
function asciiTail(name) {
  const m = name.match(/(\.[a-z][a-z]*\d*)\.json$/i);
  if (m) return m[1].toLowerCase();
  return path.extname(name).toLowerCase();
}

function resolveModelPath(rel) {
  if (fuzzyCache.has(rel)) return fuzzyCache.get(rel);

  let resolved = null;
  // Security: every segment is looked up among the children of the previous
  // segment's directory (starting at MODELS_DIR), so a crafted URL can never
  // walk out of the models tree — no traversal is possible by construction.
  const segs = rel.split('/');
  let dir = MODELS_DIR;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isLast = i === segs.length - 1;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      dir = null;
      break;
    }
    const exact = entries.find((e) =>
      isLast ? e.isFile() && e.name === seg : e.isDirectory() && e.name === seg,
    );
    if (exact) {
      dir = path.join(dir, exact.name);
      continue;
    }
    // Fuzzy: same kind (file with same extension / directory).
    const ext = path.extname(seg).toLowerCase();
    let candidates = isLast
      ? entries.filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === ext)
      : entries.filter((e) => e.isDirectory());
    if (!candidates.length) {
      dir = null;
      break;
    }
    // Texture pages are disambiguated by their trailing texture_NN token
    // even when the base names disagree entirely.
    const page = seg.match(/(texture_\d+)\.png$/i);
    if (page) {
      candidates = candidates.filter((e) => new RegExp(page[1] + '\\.png$', 'i').test(e.name));
    }
    // Two-pass match: (1) digit skeleton of the full name, (2) ASCII tail
    // (extension family like ".physics3", ".cdi3", ".moc3") PLUS the digit
    // skeleton of the name minus that tail — the tail survives mojibake
    // verbatim and disambiguates sibling files (cdi3/model3/physics3/
    // vtube all share a directory and digit skeleton). A unique match in
    // either pass resolves; otherwise fall back to a unique remaining
    // candidate, else the path is unrecoverable.
    const want = digitSkeleton(seg);
    let matches = candidates.filter((e) => digitSkeleton(e.name) === want);
    if (matches.length !== 1) {
      const tail = asciiTail(seg);
      const wantBase = digitSkeleton(seg.slice(0, seg.length - tail.length));
      matches = candidates.filter(
        (e) =>
          asciiTail(e.name) === tail &&
          digitSkeleton(e.name.slice(0, e.name.length - asciiTail(e.name).length)) === wantBase,
      );
    }
    if (matches.length !== 1) matches = candidates;
    if (matches.length === 1) {
      dir = path.join(dir, matches[0].name);
      continue;
    }
    dir = null;
    break;
  }

  if (dir && fs.existsSync(dir) && fs.statSync(dir).isFile()) {
    resolved = dir;
    if (resolved !== path.join(MODELS_DIR, rel)) {
      console.log(`[model-protocol] fuzzy: ${rel} -> ${path.relative(MODELS_DIR, resolved)}`);
    }
  }
  fuzzyCache.set(rel, resolved);
  return resolved;
}

/* ------------------------------------------------------------------ tray */

function createTrayIcon() {
  // 16x16 pink dot, drawn as raw BGRA. createFromBitmap is Windows-only,
  // which is the only platform this overlay targets for now.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = 6.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d > r) continue;
      const i = (y * size + x) * 4;
      buf[i] = 0x9d; // B
      buf[i + 1] = 0x6b; // G
      buf[i + 2] = 0xff; // R
      buf[i + 3] = d > r - 1 ? Math.round(255 * (r - d)) : 255;
    }
  }
  if (typeof nativeImage.createFromBitmap === 'function') {
    return nativeImage.createFromBitmap(buf, { width: size, height: size });
  }
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  const models = scanModels();
  return Menu.buildFromTemplate([
    {
      label: 'Pinned on top',
      type: 'checkbox',
      checked: state.pinned,
      click: (item) => setPinned(item.checked),
    },
    {
      label: 'Track mouse',
      type: 'checkbox',
      checked: state.trackMouse,
      click: (item) => setTrackMouse(item.checked),
    },
    {
      label: 'Resize window',
      type: 'checkbox',
      checked: editMode === 'container',
      click: (item) => setEditMode(item.checked ? 'container' : 'off'),
    },
    {
      label: 'Move character',
      type: 'checkbox',
      checked: editMode === 'character',
      click: (item) => setEditMode(item.checked ? 'character' : 'off'),
    },
    { type: 'separator' },
    ...models.map((m) => ({
      label: m.name,
      type: 'radio',
      checked: state.model === m.rel,
      click: () => setModel(m.rel),
    })),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('AI companion overlay');
  tray.setContextMenu(buildTrayMenu());
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/* ----------------------------------------------------------------- window */

// Minimum px of the window that must stay on-screen on each axis. Like any
// normal app window, the overlay may be dragged so it hangs off ANY screen
// edge — half of it (or more) off-screen is fine — but it can never be
// pushed FULLY off-screen: a visible, grabbable portion always remains so it
// can't be lost. `getDisplayNearestPoint` also handles a position saved on a
// monitor that is no longer attached by snapping to the nearest real display.
// The size defaults to the boot-time constants but callers that know the
// LIVE window size must pass it — the window is resizable.
const MIN_WIN_VISIBLE_PX = 100;
function clampToDisplay(x, y, w = WINDOW_W, h = WINDOW_H) {
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  const keepX = Math.min(MIN_WIN_VISIBLE_PX, w);
  const keepY = Math.min(MIN_WIN_VISIBLE_PX, h);
  return {
    // Left/right: at least keepX px of the window stay inside the display.
    x: Math.min(Math.max(x, area.x - (w - keepX)), area.x + area.width - keepX),
    // Top/bottom: at least keepY px of the window stay inside the display.
    y: Math.min(Math.max(y, area.y - (h - keepY)), area.y + area.height - keepY),
  };
}

function setPinned(pinned) {
  state.pinned = pinned;
  if (win) {
    win.setAlwaysOnTop(pinned, pinned ? 'screen-saver' : 'normal');
  }
  refreshTray();
  saveState();
  broadcastState();
}

function setTrackMouse(enabled) {
  state.trackMouse = enabled;
  refreshTray();
  saveState();
  broadcastState();
}

function setEditMode(mode) {
  editMode = mode === 'container' || mode === 'character' ? mode : 'off';
  refreshTray();
  broadcastState();
}

function setModel(rel) {
  state.model = rel;
  refreshTray();
  saveState();
  if (win) {
    win.webContents.send('overlay:model-changed', { rel, url: modelUrl(rel) });
  }
}

/** Persist the character size multiplier (bigger/smaller buttons). The
 * renderer owns the live fit; the main process owns persistence. The
 * value is clamped to the same 0.4-2.5 range the renderer applies, so a
 * corrupt/stale saved file can never wedge the fit with NaN. */
function setScaleMul(mul) {
  const n = Number(mul);
  state.scaleMul = Number.isFinite(n) ? Math.min(2.5, Math.max(0.4, n)) : 1;
  saveState();
  return state.scaleMul;
}

function broadcastState() {
  if (win) {
    win.webContents.send('overlay:state-changed', {
      pinned: state.pinned,
      trackMouse: state.trackMouse,
      editMode,
      chatOpen: Boolean(chatWin), // sync the chat button's active state
    });
  }
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workArea;

  // Restore the size the user last gave her (edit-mode resize or native
  // edge drag); guard against a hand-edited/corrupt state file.
  const w = Number.isFinite(Number(state.w)) ? Math.max(MIN_WIN_W, Math.round(state.w)) : WINDOW_W;
  const h = Number.isFinite(Number(state.h)) ? Math.max(MIN_WIN_H, Math.round(state.h)) : WINDOW_H;

  let x;
  let y;
  if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
    ({ x, y } = clampToDisplay(state.x, state.y, w, h));
  } else {
    x = Math.round(display.workArea.x + sw - w - 40);
    y = Math.round(display.workArea.y + sh - h - 20);
  }

  win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: MIN_WIN_W,
    minHeight: MIN_WIN_H,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // Resizable/maximizable so the companion can be scaled to taste; the
    // renderer re-fits her position on every size change so she stays centered
    // and never clips. Kept non-minimizable: with `skipTaskbar` a minimized
    // overlay would have no way to be restored.
    resizable: true,
    maximizable: true,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: state.pinned,
    roundedCorners: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  if (state.pinned) win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Start click-through; the renderer re-enables input when the pointer is
  // over the character or the controls.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => win.show());

  win.on('moved', () => {
    const [wx, wy] = win.getPosition();
    state.x = wx;
    state.y = wy;
    saveState();
  });

  win.on('resized', () => {
    // A maximize fires this too — persist the user's real size, which the
    // un-maximize resize delivers, not the maximized one.
    if (win.isMaximized()) return;
    const [ww, wh] = win.getSize();
    state.w = ww;
    state.h = wh;
    saveState();
  });

  win.on('closed', () => {
    win = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  }

  // Forward renderer console output here so `npm run dev` shows everything.
  // Single-argument form: Electron picks the legacy (level, message, ...)
  // signature when the listener declares extra parameters, which is deprecated.
  win.webContents.on('console-message', (event) => {
    console.log(`[renderer:${event.level}] ${event.message}`);
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[preload-error]', preloadPath, error);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[did-fail-load]', code, desc);
  });
  // Self-healing overlay: if the renderer process crashes (or OOMs), reload
  // the window so the companion comes back instead of leaving a frozen,
  // transparent blank over the desktop. Guarded against a tight crash loop
  // by only reloading if the last crash was more than a few seconds ago.
  let lastRendererCrashAt = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    logUnexpected('render-process-gone', `${details?.reason} (exitCode ${details?.exitCode})`);
    if (!win || win.isDestroyed() || win.isBeingDestroyed()) return;
    const now = Date.now();
    if (now - lastRendererCrashAt < 8000) {
      console.error('[companion] renderer kept crashing — not auto-reloading');
      return;
    }
    lastRendererCrashAt = now;
    try {
      win.webContents.reload();
    } catch (err) {
      logUnexpected('render-reload', err);
    }
  });
}

/* ----------------------------------------------------------- chat panel --- */

/**
 * The multistream chat panel: a SEPARATE frameless window (never inside the
 * character renderer). Styled by its own page (chat.html) to match the
 * companion theme. Features per panel:
 *   - header drag handle moves it, window edges resize it (native resizable)
 *   - pin button: always-on-top overlay mode, like the character window
 *   - transparency button: translucent glass vs solid background
 *   - the BotRix multistream widget iframe renders live messages itself
 * Bounds persist in the shared state file (chatState) across restarts.
 */
function createChatWindow() {
  const display = screen.getPrimaryDisplay();

  const w = Number.isFinite(chatState.w) ? Math.max(240, Math.round(chatState.w)) : 340;
  const h = Number.isFinite(chatState.h) ? Math.max(320, Math.round(chatState.h)) : 480;
  let x;
  let y;
  if (Number.isFinite(chatState.x) && Number.isFinite(chatState.y)) {
    // Clamp into the display NEAREST the saved spot, not the primary: a
    // panel saved on a secondary monitor must restore there, and a spot
    // saved on a monitor that is no longer attached snaps to the nearest
    // real display (the same rule the character window's clampToDisplay
    // uses). max() on the outside: a window wider/taller than the
    // display's work area anchors at its top-left corner instead of being
    // pushed off-screen (area.x + area.width - w goes negative there).
    const area = screen.getDisplayNearestPoint({
      x: chatState.x,
      y: chatState.y,
    }).workArea;
    x = Math.max(area.x, Math.min(chatState.x, area.x + area.width - w));
    y = Math.max(area.y, Math.min(chatState.y, area.y + area.height - h));
  } else {
    x = Math.round(display.workArea.x + 24);
    y = Math.round(display.workArea.y + 24);
  }

  chatWin = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 240,
    minHeight: 320,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true, // the chat card wants its soft shadow
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: chatState.pinned,
    roundedCorners: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'chat-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The panel embeds the BotRix widget iframe — webview/iframe needs
      // this ON for the remote page to run its scripts inside Electron.
      backgroundThrottling: false,
    },
  });

  if (chatState.pinned) chatWin.setAlwaysOnTop(true, 'screen-saver');

  chatWin.once('ready-to-show', () => chatWin.show());

  chatWin.on('moved', () => {
    if (!chatWin) return;
    const [wx, wy] = chatWin.getPosition();
    chatState.x = wx;
    chatState.y = wy;
    saveState();
  });
  chatWin.on('resized', () => {
    if (!chatWin) return;
    const [ww, wh] = chatWin.getSize();
    chatState.w = ww;
    chatState.h = wh;
    saveState();
  });
  chatWin.on('closed', () => {
    chatWin = null;
    chatState.open = false;
    saveState();
    broadcastState(); // let the character window's chat button go inactive
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    chatWin.loadURL(new URL('chat.html', devUrl).toString());
  } else {
    chatWin.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'chat.html'));
  }

  // viewer counts: poll while the panel is open, stop when it closes
  startViewerPolling();
  chatWin.once('closed', () => stopViewerPolling());

  chatWin.webContents.once('did-finish-load', () => {
    // Theme the embedded BotRix widget (panel-matched look) once its frame
    // appears — the iframe loads after the panel page, so poll briefly.
    // Keep injecting until the widget frame is up AND has rendered real
    // chat rows (the styling — and the one-shot structure diagnostic —
    // must land on actual messages), then stop: the injected
    // MutationObserver keeps normalizing rows that arrive later, and
    // re-theming is redone on demand by the transparency toggle. The 30 s
    // cap ends the poll for widgets that never load at all.
    const frameTimer = setInterval(() => {
      if (!chatWin || chatWin.isDestroyed()) {
        clearInterval(frameTimer);
        return;
      }
      if (!injectChatWidgetStyle()) return; // widget frame not up yet
      widgetHasChatRows()
        .then((hasRows) => {
          if (!hasRows) return; // keep polling until real messages exist
          clearInterval(frameTimer);
          injectChatWidgetStyle(); // one final injection, then stop
        })
        .catch(() => {});
    }, 1500);
    setTimeout(() => clearInterval(frameTimer), 30000);
    chatWin.once('closed', () => clearInterval(frameTimer));
  });

  chatState.open = true;
  saveState();
}

function setChatOpen(open) {
  if (open && !chatWin) {
    createChatWindow();
  } else if (!open && chatWin) {
    chatWin.close(); // 'closed' handler clears state + broadcastState
    return;
  }
  broadcastState();
}

/** The BotRix multistream widget URL for the chat panel's iframe — the
 * exact page an OBS browser source loads. Optional: put
 * BOTRIX_WIDGET_URL=https://... in frontend/.env */
function getBotrixWidgetUrl() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const envText = fs.readFileSync(envPath, 'utf8');
    const m = envText.match(/^\s*BOTRIX_WIDGET_URL\s*=\s*(.+)$/m);
    let url = m ? m[1].trim() : '';
    if (url.startsWith('"') && url.endsWith('"')) url = url.slice(1, -1);
    if (url.startsWith("'") && url.endsWith("'")) url = url.slice(1, -1);
    return url || null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------- viewer counts --- */

// BotRix's viewers widget uses plain REST polling (decoded from their
// bundle): /api/widgets/viewers?platform=X&bid=Y returns the live count
// per platform. We poll the same endpoint from the main process and push
// the counts to the chat panel's header — same bid, same session.
const VIEWER_POLL_S = 30; // the widget's own cadence
let viewerTimer = null;

async function fetchPlatformViewers(bid, platform) {
  try {
    const url = `https://botrix.live/api/widgets/viewers?platform=${platform}&bid=${bid}`;
    // NOTE: no Referer header. A custom Referer is a fetch-spec forbidden
    // header that Electron's network service rejects outright in some
    // contexts (ERR_BLOCKED_BY_CLIENT — the whole poll fails with it), and
    // the live endpoint returns the identical body without it (verified:
    // {"viewerCount":N,"ok":...} both ways), so it was never needed. The
    // browser UA stays — plain net.fetch sends the Electron UA otherwise.
    const res = await net.fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return 0;
    const data = await res.json();
    const n = Number(data && data.viewerCount);
    return Number.isFinite(n) && n > 0 ? n : 0; // -1 (offline) and 0 read as 0
  } catch {
    return 0;
  }
}

/** Poll all platforms' viewer counts and push them to the chat panel.
 * Failure of any platform just reads as 0 — the poller never crashes.
 * When no widget URL is configured there is no bid to poll with, so the
 * poll disarms itself instead of waking every 30 s forever to do
 * nothing (startViewerPolling will re-arm it if the panel is reopened
 * after a URL has been added). */
async function pollViewerCounts() {
  const bid = getBotrixBid();
  if (!bid) {
    stopViewerPolling();
    return;
  }
  const [twitch, youtube, kick] = await Promise.all([
    fetchPlatformViewers(bid, 'twitch'),
    fetchPlatformViewers(bid, 'youtube'),
    fetchPlatformViewers(bid, 'kick'),
  ]);
  const total = twitch + youtube + kick;
  const payload = { total, twitch, youtube, kick };
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.send('chat:viewers', payload);
  }
}

/** Extract the bid from the configured widget URL (single source of truth:
 * BOTRIX_WIDGET_URL carries the session id). */
function getBotrixBid() {
  const url = getBotrixWidgetUrl();
  if (!url) return null;
  const m = url.match(/[?&]bid=([^&]+)/);
  return m ? m[1] : null;
}

function startViewerPolling() {
  if (viewerTimer) return;
  pollViewerCounts(); // immediate first count
  viewerTimer = setInterval(pollViewerCounts, VIEWER_POLL_S * 1000);
}

function stopViewerPolling() {
  if (viewerTimer) {
    clearInterval(viewerTimer);
    viewerTimer = null;
  }
}

/* ------------------------------------------- chat widget panel-theme --- */

// Platform icon paths (24x24 library shapes, same as the old panel used).
const CHAT_ICON_PATHS = {
  youtube:
    'M23 7.3c-.3-1-1-1.8-2-2C19.2 4.8 12 4.8 12 4.8s-7.2 0-9 .5c-1 .2-1.7 1-2 2C.5 9 .5 12 .5 12s0 3 .5 4.7c.3 1 1 1.8 2 2 1.8.5 9 .5 9 .5s7.2 0 9-.5c1-.2 1.7-1 2-2 .5-1.7.5-4.7.5-4.7s0-3-.5-4.7zM9.8 15.5v-7l6.2 3.5-6.2 3.5z',
  twitch:
    'M4.3 3 3 6.2v13.2h4.6L10.3 22h2.4l2.7-2.6h4.2L22 15V3H4.3zm15.4 11.2-2.6 2.5h-4.2l-2.7 2.6v-2.6H7V4.8h12.7v9.4zM11 8.4h1.8v5H11V8.4zm4.7 0h1.8v5h-1.8v-5z',
  kick: 'M5 3h4v4h2V5h2V3h6v4h-2v2h2v4h-2v2h2v6h-6v-2h-2v-2H9v2H5V3z',
};

/** Build the panel-theme CSS injected into the embedded BotRix frame —
 * makes the messages look like the OLD panel: Segoe UI 12.5px pills that
 * hug their content, bold usernames, library platform icons, faint
 * zebra rows. Text color follows the panel mode: WHITE text (with soft
 * dark shadow for readability over any background) in transparent/glass
 * mode, BLACK text in solid mode — usernames included, no other colors. */
function buildChatWidgetCss() {
  const light = chatState.transparent; // glass mode -> white text
  const fg = light ? '#ffffff' : '#000000';
  const pill = light ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.045)';
  const zebra = light ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.07)';
  const shadow = light ? '0 1px 3px rgba(0,0,0,0.7)' : 'none';
  const thumb = light ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.18)';
  const svg = (d) =>
    `url("data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='${fg}'><path d='${d}'/></svg>`,
    )}")`;
  const iconRow = (cls, platform) => `
    .chatMsg.hik-pl-${cls}::before {
      content: ${svg(CHAT_ICON_PATHS[platform])} !important;
      display: inline-block !important;
      width: 16px !important; height: 16px !important;
      margin-right: 3px !important; vertical-align: -3px !important;
      background-repeat: no-repeat !important; background-size: contain !important;
    }`;
  return `
    *, *::before, *::after { color: ${fg} !important; text-shadow: ${shadow} !important; }
    img, video { filter: grayscale(1) !important; }
    /* strip the widget's own platform favicons; rows are tagged hik-pl-* */
    img.badge { display: none !important; }
    /* message container: rows stack from the TOP (old panel behavior),
       full width so every pill lines up — padded off the panel borders */
    #chatlist {
      display: flex !important;
      flex-direction: column !important;
      justify-content: flex-start !important;
      height: 100% !important;
      overflow-y: auto !important;
      padding: 4px 10px 10px 12px !important;
      box-sizing: border-box !important;
    }
    .chatMsg {
      font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif !important;
      font-size: 12.5px !important;
      line-height: 1.45 !important;
      background-color: ${pill} !important;
      border-radius: 10px !important;
      padding: 4px 10px !important;
      margin: 0 0 2px 0 !important;
      width: fit-content !important;
      max-width: 100% !important;
      min-width: 0 !important;
      box-sizing: border-box !important;
      flex: 0 0 auto !important;
      text-align: left !important;
      word-wrap: break-word !important; overflow-wrap: anywhere !important;
    }
    .chatMsg:nth-child(even) { background-color: ${zebra} !important; }
    /* message inner text: same size as the old panel — the widget ships
       larger; normalize ALL message text spans inside the row */
    .chatMsg, .chatMsg * {
      font-size: 12.5px !important;
      line-height: 1.45 !important;
    }
    /* Rebuilt rows (see the normalizer): EXACT old-panel format —
       [icon] <b>name:</b> message. Bold lives ONLY on .hik-name; the colon
       (.hik-sep) and message (.hik-msg) are forced to regular weight so
       the widget's own b/strong inheritance can never leak boldness. */
    .chatMsg .hik-name {
      font-weight: 700 !important;
      color: ${fg} !important;
      font-size: 12.5px !important;
      margin: 0 !important;
    }
    .chatMsg .hik-sep,
    .chatMsg .hik-msg,
    .chatMsg .hik-msg *,
    .chatMsg .hik-msg b,
    .chatMsg .hik-msg strong {
      font-weight: 400 !important;
    }
    /* hide the widget's scrollbar entirely (mouse wheel still scrolls) */
    #chatlist::-webkit-scrollbar { width: 0 !important; display: none !important; }
    #chatlist { scrollbar-width: none !important; -ms-overflow-style: none !important; }
    /* donation/redemption rows keep their native DOM — bold their names
       through the widget's own .name class there */
    .chatMsg .name {
      font-weight: 700 !important;
      color: ${fg} !important;
      font-size: 12.5px !important;
      margin-left: 0 !important;
    }
    .chatMsg .user, .chatMsg .link { color: ${fg} !important; font-weight: 400 !important; }
    ${iconRow('youtube', 'youtube')}
    ${iconRow('twitch', 'twitch')}
    ${iconRow('kick', 'kick')}
    ::-webkit-scrollbar-thumb { background: ${thumb} !important; border-radius: 8px; }
    ::-webkit-scrollbar { width: 8px; }
  `;
}

/** Runs INSIDE the widget frame: normalizes every message row into the
 * EXACT old-panel format regardless of the widget's internal markup:
 *
 *   <icon> <b>name:</b> message
 *
 * Extraction notes (measured from the live widget):
 *   - kick rows NEST the .message element INSIDE the .name element, so
 *     name.textContent alone reads "username message". The name text is
 *     extracted from a clone with .message/.badges stripped, plus an
 *     endsWith fallback for bare text nodes.
 *   - no permanent skip flag: if the widget re-renders a row (emotes,
 *     updates), .name/.message reappear and the row is re-normalized —
 *     the observer wins the render war by always converging to our format.
 *   - rows without .name/.message (already rebuilt, system rows) are
 *     naturally skipped.
 *   - donation/redemption rows keep their native layouts. */
function buildChatWidgetObserverJs() {
  return `(() => {
    const PLATFORMS = {
      youtube: /youtube|ytimg|gstatic/,
      twitch: /twitch|jtvnw/,
      kick: /kick/,
    };
    const normalize = (row) => {
      if (!row || !row.classList) return;
      if (row.querySelector('.donation-container, .redemption-container, [class*="gift"]')) return;
      const nameEl = row.querySelector('.name');
      const msgEl = row.querySelector('.message');
      if (!nameEl || !msgEl) return; // rebuilt already / not a chat row

      // platform icon tag (before the badge is hidden by CSS/rebuild)
      const badge = row.querySelector('img.badge');
      const src = badge ? (badge.src || '') : '';
      const cls = row.className || '';
      let platform = '';
      for (const [pl, re] of Object.entries(PLATFORMS)) {
        if (re.test(src) || cls.includes(pl)) { row.classList.add('hik-pl-' + pl); platform = pl; break; }
      }
      if (!platform) platform = (cls.match(/hik-pl-(\\w+)/) || [])[1] || '';

      // username text WITHOUT the message: clone the name, strip nested
      // .message/.badges/img (kick nests them), read the remainder
      const nameClone = nameEl.cloneNode(true);
      nameClone.querySelectorAll('.message, .badges, img, span[class*="name"]').forEach((n) => n.remove());
      let nameText = (nameClone.textContent || '').trim();
      const msgText = (msgEl.textContent || '').trim();
      // fallback: message still trailing in the name text (bare text node)
      if (msgText && nameText.endsWith(msgText)) {
        nameText = nameText.slice(0, nameText.length - msgText.length).trim();
      }
      if (!nameText) nameText = (nameEl.textContent || '').trim().replace(msgText, '').trim();
      if (!nameText || !msgText) return;

      const msgKids = [...msgEl.childNodes];

      row.textContent = '';
      const name = document.createElement('span');
      name.className = 'hik-name';
      name.textContent = nameText;
      const sep = document.createElement('span');
      sep.className = 'hik-sep';
      sep.textContent = ': ';
      const msg = document.createElement('span');
      msg.className = 'hik-msg';
      msg.append(...msgKids);
      row.append(name, sep, msg);
    };
    const scan = () => document.querySelectorAll('.chatMsg').forEach(normalize);
    scan();
    if (!window.__hikObs) {
      window.__hikObs = new MutationObserver(() => scan());
      window.__hikObs.observe(document.body, { childList: true, subtree: true });
    }
  })()`;
}

/** Inject (or re-theme) the panel-theme style + platform tagger inside the
 * embedded BotRix widget frame. The panel window is the embedder, so it may
 * script the cross-origin frame. Re-running replaces the same style tag, so
 * the transparency toggle re-themes the widget live.
 * Returns true when the widget frame was found and injected into. */
function injectChatWidgetStyle() {
  if (!chatWin || chatWin.isDestroyed()) return false;
  const css = buildChatWidgetCss();
  const observerJs = buildChatWidgetObserverJs();
  const code = `(() => {
    const id = 'hikasha-widget-style';
    let el = document.getElementById(id);
    if (!el) { el = document.createElement('style'); el.id = id; }
    el.textContent = ${JSON.stringify(css)};
    (document.head || document.documentElement).appendChild(el);
    ${observerJs}
  })()`;
  let frames;
  try {
    frames = chatWin.webContents.mainFrame.frames;
  } catch {
    return false;
  }
  let injected = false;
  for (const frame of frames) {
    if (frame && frame.url && frame.url.includes('botrix.live')) {
      injected = true;
      Promise.resolve(frame.executeJavaScript(code, false)).catch(() => {});
    }
  }
  return injected;
}

/** True when the embedded BotRix widget frame has rendered at least one
 * real chat row (.chatMsg) — the "widget is fully up" stop condition for
 * the styling poll. Resolves false when the frame isn't up yet (or on any
 * error: keep polling until the 30 s cap). */
async function widgetHasChatRows() {
  if (!chatWin || chatWin.isDestroyed()) return false;
  let frames;
  try {
    frames = chatWin.webContents.mainFrame.frames;
  } catch {
    return false;
  }
  for (const frame of frames) {
    if (frame && frame.url && frame.url.includes('botrix.live')) {
      try {
        const rows = await frame.executeJavaScript(
          'document.querySelectorAll(".chatMsg").length',
          false,
        );
        if (Number(rows) > 0) return true;
      } catch {
        /* frame navigated away mid-probe — keep polling */
      }
    }
  }
  return false;
}

/* -------------------------------------------------------- cursor tracking */

// Gaze follows the GLOBAL cursor, but the renderer only receives native
// mousemove while the pointer is inside the window. Two paths, each used
// where it is fastest:
//  - IN-WINDOW: the renderer's own mousemove listener feeds the driver
//    directly (zero IPC, zero polling — the lowest-latency path, used the
//    overwhelming majority of the time).
//  - OUT-OF-WINDOW: this poll streams the global cursor window-relative
//    at 10 ms — close to a frame, still smooth — and stops entirely
//    (timer unref'd) while the pointer stays inside the window.
// Never polled at all while mouse tracking is off.
function startCursorTracking() {
  const POLL_MS = 10;
  let last = null;
  const tick = () => {
    if (!win || win.isDestroyed()) return;
    if (!state.trackMouse) {
      last = null; // forget the old spot so re-enabling picks up fresh moves
      return;
    }
    const bounds = win.getBounds();
    const point = screen.getCursorScreenPoint();
    const inside =
      point.x >= bounds.x &&
      point.x < bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y < bounds.y + bounds.height;
    if (inside) {
      // Native mousemove owns it in here — skip (and forget, so leaving the
      // window resumes from a fresh spot).
      last = null;
      return;
    }
    if (last && point.x === last.x && point.y === last.y) return;
    last = point;
    win.webContents.send('overlay:cursor', {
      x: point.x - bounds.x,
      y: point.y - bounds.y,
    });
  };
  const timer = setInterval(tick, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/* -------------------------------------------------------------------- ipc */

function registerIpc() {
  ipcMain.on('overlay:set-ignore', (_e, ignore) => {
    if (win) win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  });

  ipcMain.on('overlay:drag-start', (_e, grabX, grabY) => {
    dragOffset = { x: Number(grabX) || 0, y: Number(grabY) || 0 };
  });

  ipcMain.on('overlay:drag-move', (_e, screenX, screenY) => {
    if (!win || !dragOffset) return;
    // Clamped with the same limits as boot (and the window's LIVE size), so
    // the window can never be dragged into a spot where it (and the
    // character) vanishes off-screen.
    const [ww, wh] = win.getSize();
    const pos = clampToDisplay(
      Math.round(screenX - dragOffset.x),
      Math.round(screenY - dragOffset.y),
      ww,
      wh,
    );
    win.setPosition(pos.x, pos.y);
  });

  ipcMain.on('overlay:drag-end', () => {
    dragOffset = null;
    if (win) {
      const [wx, wy] = win.getPosition();
      state.x = wx;
      state.y = wy;
      saveState();
    }
  });

  ipcMain.handle('overlay:toggle-pin', () => {
    setPinned(!state.pinned);
    return state.pinned;
  });

  ipcMain.handle('overlay:toggle-track-mouse', () => {
    setTrackMouse(!state.trackMouse);
    return state.trackMouse;
  });

  /* ------------------------------------------------------ chat panel IPC --- */

  // The character window's chat button toggles the separate panel window.
  // Returns the TRUE open state — if window creation fails, the renderer
  // must see false so the button doesn't stay lit on a dead toggle.
  ipcMain.handle('overlay:toggle-chat', () => {
    const wanted = !chatWin;
    try {
      setChatOpen(wanted);
    } catch (err) {
      console.error('[chat] toggle failed:', err.message);
      return false;
    }
    return Boolean(chatWin);
  });

  ipcMain.handle('chat:toggle-pin', () => {
    chatState.pinned = !chatState.pinned;
    if (chatWin) chatWin.setAlwaysOnTop(chatState.pinned, 'screen-saver');
    saveState();
    return chatState.pinned;
  });

  ipcMain.handle('chat:toggle-transparent', () => {
    chatState.transparent = !chatState.transparent;
    saveState();
    // re-theme the embedded widget live (white <-> black text)
    injectChatWidgetStyle();
    // true = now OPAQUE (transparent off) — the renderer styles accordingly
    return !chatState.transparent;
  });

  ipcMain.handle('chat:get-state', () => ({
    pinned: chatState.pinned,
    transparent: chatState.transparent,
  }));

  // The BotRix widget URL for the panel's iframe (from BOTRIX_WIDGET_URL).
  ipcMain.handle('chat:get-widget-url', () => getBotrixWidgetUrl());

  // Panel close button — same path as toggling off from the character menu.
  ipcMain.on('chat:close', () => {
    setChatOpen(false);
  });

  ipcMain.handle('overlay:get-state', () => {
    const models = scanModels();
    // The saved model may no longer exist (e.g. models were replaced) — fall
    // back to the first available one instead of loading nothing.
    if (!models.some((m) => m.rel === state.model)) {
      state.model = models.length ? models[0].rel : null;
      refreshTray();
      saveState();
    }
    return {
      pinned: state.pinned,
      trackMouse: state.trackMouse,
      model: state.model,
      modelUrl: state.model ? modelUrl(state.model) : null,
      models,
      scaleMul: state.scaleMul,
      charOffset: state.charOffset,
      editMode,
      chatOpen: Boolean(chatWin),
    };
  });

  ipcMain.handle('overlay:set-model', (_e, rel) => {
    setModel(rel);
    return { rel, url: modelUrl(rel) };
  });

  // Fallback physics discovery: list the *.physics3.json files inside a
  // model's folder (rel path). Used when a model3.json has no
  // FileReferences.Physics entry — the renderer then tries each discovered
  // file over the model protocol. Empty on failure.
  ipcMain.handle('overlay:find-physics', (_e, rel) => {
    try {
      const dir = resolveModelPath(rel.split('/').slice(0, -1).join('/'));
      const base = dir && dir.startsWith(MODELS_DIR + path.sep) ? dir : MODELS_DIR;
      const target = path.resolve(base, rel);
      const folder = path.dirname(target);
      if (!folder.startsWith(MODELS_DIR + path.sep)) return [];
      return fs
        .readdirSync(folder)
        .filter((f) => /\.physics3\.json$/i.test(f))
        .map((f) => path.posix.join(...path.posix.dirname(rel.split('/').join('/')).split('/'), f));
    } catch {
      return [];
    }
  });

  // Persist the character size multiplier (renderer's bigger/smaller).
  ipcMain.handle('overlay:set-scale-mul', (_e, mul) => setScaleMul(mul));

  ipcMain.handle('overlay:set-edit-mode', (_e, mode) => {
    setEditMode(mode);
    return editMode;
  });

  // Edit-mode resize/move: the renderer sends the desired window bounds in
  // SCREEN coordinates (the window moves/resizes under the pointer mid-drag,
  // so window-relative coords can't describe it). Size is floored at the
  // window minimums and the position clamped with the same limits as boot
  // and the window drag, so she can never be lost off-screen. The 'moved'/
  // 'resized' handlers persist the result.
  ipcMain.on('overlay:set-window-bounds', (_e, bounds) => {
    if (!win || win.isDestroyed() || !bounds || typeof bounds !== 'object') return;
    const w = Math.max(MIN_WIN_W, Math.round(Number(bounds.w) || MIN_WIN_W));
    const h = Math.max(MIN_WIN_H, Math.round(Number(bounds.h) || MIN_WIN_H));
    const [curX, curY] = win.getPosition();
    const rawX = Number(bounds.x);
    const rawY = Number(bounds.y);
    const pos = clampToDisplay(
      Number.isFinite(rawX) ? Math.round(rawX) : curX,
      Number.isFinite(rawY) ? Math.round(rawY) : curY,
      w,
      h,
    );
    win.setBounds({ x: pos.x, y: pos.y, width: w, height: h });
  });

  // The character offset arrives as fractions of the window. The renderer
  // already clamps it; this is just belt-and-braces against a malformed
  // payload corrupting the saved state. It may legitimately exceed ±1: the
  // character is allowed to hang off the window edges (a visible anchor
  // always stays in view).
  const clampNum = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  ipcMain.on('overlay:set-char-offset', (_e, charOffset) => {
    if (!charOffset || typeof charOffset !== 'object') return;
    state.charOffset = {
      // Wide range: with the scale multiplier the model can dwarf the
      // window, pushing its clamped offset well beyond one window width.
      x: clampNum(charOffset.x, -4, 4, state.charOffset.x),
      y: clampNum(charOffset.y, -4, 4, state.charOffset.y),
    };
    saveState();
  });

  ipcMain.on('overlay:close', () => {
    console.log('[quit-debug] overlay:close IPC received — quitting');
    app.quit();
  });
}

/* ------------------------------------------------------------------ boot */

// Serve character model files to the renderer over a privileged scheme.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MODEL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // LOUD, actionable: a silent exit-0 here looks like a crash ("app won't
  // start") when the truth is an older instance is still running (hidden
  // overlay + tray icon from a previous session, easy to leave behind
  // when a stream ends in a hurry). Tell the user exactly what to do.
  console.error(
    '[startup] another instance of the overlay is already running (check ' +
      'the system tray for the AI companion icon — right-click > Quit), or ' +
      'kill it from Task Manager (electron.exe). This window will now close.',
  );
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) win.show();
    // The user re-launched the app — restore the chat panel too if they
    // had it open (or left it open last session and hid it), mirroring
    // the character window's "bring everything back" behavior.
    if (chatState.open) setChatOpen(true);
    else if (chatWin) chatWin.show();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('ai-assistant.companion-overlay');

    protocol.handle(MODEL_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        // The fuzzy walker can never escape MODELS_DIR (it only ever
        // descends through readdir entries), but belt-and-braces: verify
        // the resolved file is still inside the models tree.
        const target = resolveModelPath(rel);
        if (!target) {
          return new Response('Not found', { status: 404 });
        }
        if (target !== MODELS_DIR && !target.startsWith(MODELS_DIR + path.sep)) {
          return new Response('Forbidden', { status: 403 });
        }
        const res = await net.fetch(pathToFileURL(target).toString());
        // PixiJS loads textures through <img crossorigin>, so the
        // responses must carry an explicit CORS allowance.
        const headers = new Headers(res.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      } catch (err) {
        console.error('[model-protocol]', err);
        return new Response('Bad request', { status: 400 });
      }
    });

    loadState();
    registerIpc();
    createWindow();
    createTray();
    startCursorTracking();
    // Restore the chat panel if the user left it open last session.
    if (chatState.open) setChatOpen(true);
  });

  app.on('window-all-closed', () => {
    console.log('[quit-debug] window-all-closed — all windows gone');
    app.quit();
  });

  // Flush a pending (debounced) state save so the last window position /
  // model choice is not lost when the app quits within the debounce window.
  app.on('before-quit', () => {
    console.log('[quit-debug] before-quit fired');
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
      writeState();
    }
  });
}
