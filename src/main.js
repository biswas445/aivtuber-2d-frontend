import './styles.css';
// Chromium's CSP blocks `new Function` (script-src 'self'), which PixiJS
// v6 uses for shader/batch codegen — this shim replaces it with a
// CSP-safe path. Must be imported BEFORE any renderer/sprite is created.
import { install } from '@pixi/unsafe-eval';
import * as PIXI from 'pixi.js';
install(PIXI);
import { Live2DModel, CubismPhysics } from 'pixi-live2d-display/cubism4';
import {
  createIcons,
  Pin,
  PinOff,
  RefreshCw,
  Plus,
  Minus,
  X,
  MousePointer,
  MousePointer2Off,
  ScanBox,
  PersonStanding,
  MessageCircleHeart,
  Smile,
} from 'lucide';
import { IdleDriver } from './idle.js';
import { ChoreoEngine, CHOREO_KEYS } from './choreo.js';
import { SecondaryLayer } from './secondary.js';
import { setupOverlay } from './overlay.js';
import { setupEditMode } from './edit-mode.js';

createIcons({
  icons: {
    Pin,
    PinOff,
    RefreshCw,
    Plus,
    Minus,
    X,
    MousePointer,
    MousePointer2Off,
    ScanBox,
    PersonStanding,
    MessageCircleHeart,
    Smile,
  },
});

/* ---------------------------------------------------------------- stage --- */
// Transparent WebGL canvas hosted by the frameless overlay window. The
// character is rendered against a fully transparent clear color so only she
// (and the toolbar) is visible on the desktop.

// pixi-live2d-display 0.4.x rides on PixiJS v6. When used as an ESM module
// (no script-tag global), the plugin needs the PIXI global exposed once and
// its ticker registered so `autoUpdate`/`autoInteract` wiring can find the
// Ticker class. The Cubism Core runtime script is loaded by index.html
// BEFORE this module evaluates (window.Live2DCubismCore must exist at
// import time, or the framework import throws).
window.PIXI = PIXI;
Live2DModel.registerTicker(PIXI.Ticker);

/* ------------------------------------------------ error visibility ---
 * An always-on overlay that fails SILENTLY is the worst failure mode: a
 * single unhandled rejection in the render loop freezes the character with
 * no on-screen trace. These window-level handlers turn that invisible
 * freeze into a logged banner; the render-loop guard below keeps the loop
 * alive across a bad frame instead of dying on it. Errors are surfaced via
 * console.error so the main process banner (which forwards renderer console
 * output) shows them too.
 */
window.addEventListener('error', (e) => {
  console.error('[vtuber] uncaught window error:', e?.error || e?.message, e?.error?.stack || '');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[vtuber] unhandled promise rejection:', e?.reason);
});

// Throttled logging so a repeating frame error (e.g. a transient model
// glitch) rings loud once instead of spamming thousands of identical lines.
let lastFrameErrorAt = 0;
const FRAME_ERROR_LOG_RATE = 1000; // ms between repeated frame-error logs
function reportFrameError(err) {
  const now = performance.now();
  if (now - lastFrameErrorAt < FRAME_ERROR_LOG_RATE) return;
  lastFrameErrorAt = now;
  console.error('[vtuber] frame error (loop continues):', err, err?.stack || '');
}

const app = new PIXI.Application({
  antialias: true,
  autoDensity: true, // canvas CSS size stays in CSS px, buffer at native DPI
  resolution: window.devicePixelRatio || 1,
  backgroundAlpha: 0, // fully transparent clear — only she is visible
  powerPreference: 'high-performance',
});
document.getElementById('stage-holder').appendChild(app.view);

// The model renders INSIDE this container (a PIXI.Container transform is
// "the rig" — it carries the fitted position/scale, exactly like the
// reference's rig group).
const stage = new PIXI.Container();
app.stage.addChild(stage);

const state = {
  models: [],
  current: null, // rel path of the loaded model
  model: null, // Live2DModel instance
  rig: null, // Container carrying the fitted position/scale
  unitBounds: null, // model bounds at unit scale (measured once per load)
  idle: null, // IdleDriver
  choreo: null, // ChoreoEngine (authored animation, rebuilt per model)
  secondary: null, // SecondaryLayer (ears/hair/skirt, post-physics)
  scaleMul: 1,
  trackMouse: true, // whether the gaze follows the global cursor
  charRect: null, // screen-space character rect for hit-testing (per frame)
  // User's character offset inside the window, fractions of the window
  // (x+ = right, y+ = down on screen). Default: centered, feet on the
  // window's bottom margin. The window itself is the container the
  // character is fitted into — resizing it re-fits her live.
  charOffset: { x: 0, y: 0 },
};

/* ------------------------------------------------------------------- fit --- */
// Fitting works in window PX exactly like the reference: the model's
// unit-scale bounds (its layout frame in Cubism model space) are scaled so
// she fits the window's safe area with her feet resting just above the
// bottom margin, then shifted by the user's offset and clamped so a visible
// portion always stays in view.

// Safe margins (fractions of the viewport) kept around the character when
// fitting. The top margin is generous so upward moves have headroom and the
// head never clips the top edge; the bottom pad keeps the feet just above the
// window edge.
const FIT_MARGIN_SIDE = 0.04;
const FIT_MARGIN_TOP = 0.1;
const FIT_MARGIN_BOTTOM = 0.02;
const FIT_BOTTOM_PAD = 4;

// Last viewport the fit was computed for — the render loop compares these to
// the live size every frame so a missed/stale resize event (minimize →
// maximize, DPI changes) can never leave the character mis-positioned.
let lastFitW = 0;
let lastFitH = 0;
let lastFitDPR = 0;
// Fitted geometry from the last fitModel run — shared with the character
// drag so it clamps with exactly the same limits the rendering uses.
let lastFitGeometry = null; // { widthPx, heightPx, anchorX, anchorY }

/** Measure the model's bounds at unit scale (once per load). The Live2D
 * display object spans `internalModel.width/height` — the moc3 canvas
 * dimensions in PIXELS (scaled by the model3.json Layout when present).
 * The display frame's origin is top-left; the character's FEET sit at the
 * canvas bottom (Cubism draws upward from y=0). */
function ensureUnitBounds() {
  const model = state.model;
  if (!model) return false;
  if (state.unitBounds) return true;
  const im = model.internalModel;
  if (!im) return false;
  const width = im.width;
  const height = im.height;
  if (!(width > 0) || !(height > 0)) return false;
  state.unitBounds = {
    width,
    height,
  };
  const entry = modelCache.get(state.current);
  if (entry) entry.unitBounds = state.unitBounds;
  applyRestTransform();
  return true;
}

/** Offset the model inside the rig so her feet's bottom-center sits at the
 * rig's origin — whole-body poses (sways, rises) then pivot around the
 * feet. The Live2DModel display object spans its layout frame top-left to
 * bottom-right in DISPLAY space (y+ down); anchor (0.5, 1) puts the pivot
 * at the bottom-center of the canvas — where the feet are. */
function applyRestTransform() {
  const model = state.model;
  if (!model) return;
  model.anchor.set(0.5, 1);
}

/** The container rect in window px — the window itself is the container. */
function containerPx() {
  return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
}

// Minimum px of the model that must stay inside the window on each axis.
// She may hang off ANY edge (the overlay clips her), but can never be pushed
// entirely off-screen — a visible, grabbable portion always remains.
const MIN_VISIBLE_PX = 80;

/**
 * Clamp a feet anchor (window px) so she can never be lost off-screen — the
 * ONE limit used by both the rendering (fitModel) and the character drag,
 * which is what makes the drag symmetric: the character follows the cursor
 * exactly everywhere she can actually be rendered, and stops precisely
 * where the render clamp stops her. The model may cross any window edge —
 * left, right, top and bottom alike — as long as at least MIN_VISIBLE_PX px
 * of it stay in view on that axis.
 */
function clampFeetPx(feetPx, feetPy, widthPx, heightPx, W, H) {
  const half = widthPx / 2;
  const keepX = Math.min(MIN_VISIBLE_PX, widthPx);
  const keepY = Math.min(MIN_VISIBLE_PX, heightPx);
  // Horizontal: at least keepX px of the model stay inside the window.
  const x = Math.min(Math.max(feetPx, keepX - half), W - keepX + half);
  // feetPy is the model's BOTTOM; its top is feetPy - heightPx. Going up the
  // bottom must stay in view; going down the top must stay in view.
  const y = Math.min(Math.max(feetPy, keepY), H - keepY + heightPx);
  return { x, y };
}

/**
 * Clamp a proposed character offset (window px) with the same visibility
 * limits the rendering applies (see clampFeetPx). Used live during the
 * character drag.
 */
function clampCharOffsetPx(offPx) {
  const g = lastFitGeometry;
  if (!g) return offPx;
  const feet = clampFeetPx(
    g.anchorX + offPx.x,
    g.anchorY + offPx.y,
    g.widthPx,
    g.heightPx,
    window.innerWidth,
    window.innerHeight,
  );
  return { x: feet.x - g.anchorX, y: feet.y - g.anchorY };
}

/**
 * Fit the character to the current viewport: renderer resolution, model
 * scale and position are all recomputed from scratch, so a resize/maximize/
 * restore can never accumulate drift or clip the face. The window itself is
 * the container: she is fitted into the full window, then shifted by the
 * user's character offset.
 *
 * Positioning works in window PX (intuitive, resolution-independent math):
 *  1. feet anchor = window bottom safe margin + user offset,
 *  2. clamp the resulting model rect against the window: she may hang off
 *     any edge, but at least MIN_VISIBLE_PX px of her stay in view, so she
 *     can never be lost off-screen. The clamp result is written back to
 *     state.charOffset so stored, rendered and persisted positions agree.
 */
function fitModel() {
  const model = state.model;
  const rig = state.rig;
  if (!model || !rig) return;
  if (!ensureUnitBounds()) return;

  const W = window.innerWidth;
  const H = window.innerHeight;
  // While a window is minimized (or mid-transition) Windows can report a
  // degenerate viewport. Fitting against it would blow up the scale/position,
  // so skip and retry until the real size is back.
  if (!W || !H || W < 8 || H < 8) {
    requestAnimationFrame(fitModel);
    return;
  }

  // The device pixel ratio can change (monitor moves, OS zoom) — keep the
  // drawing buffer in sync or the fit math and the canvas disagree.
  const dpr = window.devicePixelRatio || 1;
  app.renderer.resolution = dpr;
  app.renderer.resize(W, H);
  lastFitW = W;
  lastFitH = H;
  lastFitDPR = dpr;

  const b = state.unitBounds;
  const c = containerPx();

  // Scale to fit the window's safe area, then apply the user's scale
  // multiplier. unitBounds is in canvas PIXELS (the layout frame), and the
  // display object spans exactly width×height at scale 1 — so scale maps
  // canvas px → screen px directly.
  const marginX = c.w * FIT_MARGIN_SIDE;
  const marginTop = c.h * FIT_MARGIN_TOP;
  const marginBottom = c.h * FIT_MARGIN_BOTTOM + FIT_BOTTOM_PAD;
  const availW = Math.max(1, c.w - marginX * 2);
  const availH = Math.max(1, c.h - marginTop - marginBottom);
  const scale = Math.min(availW / b.width, availH / b.height) * state.scaleMul;
  rig.scale.set(scale);

  // Model extent on screen at this scale.
  const widthPx = b.width * scale;
  const heightPx = b.height * scale;

  // Feet anchor in window px: window bottom safe margin + user offset,
  // clamped to the window visibility limits (shared with the character drag).
  const anchorX = c.x + c.w / 2;
  const anchorY = c.y + c.h - marginBottom;
  lastFitGeometry = { widthPx, heightPx, anchorX, anchorY };
  const feet = clampFeetPx(
    anchorX + state.charOffset.x * W,
    anchorY + state.charOffset.y * H,
    widthPx,
    heightPx,
    W,
    H,
  );
  const feetPx = feet.x;
  const feetPy = feet.y;

  // Write the clamped anchor back as fractions so stored state matches what
  // is rendered (a maximize can otherwise keep re-amplifying a stale offset).
  const offX = (feetPx - anchorX) / W;
  const offY = (feetPy - anchorY) / H;
  if (Math.abs(offX - state.charOffset.x) > 1e-4 || Math.abs(offY - state.charOffset.y) > 1e-4) {
    state.charOffset = { x: offX, y: offY };
    window.overlay.setCharOffset(state.charOffset);
  }

  // Window px → screen position. The rig origin is the feet anchor; the
  // model is anchored bottom-center inside it (applyRestTransform), so the
  // rig position IS the feet position in screen px. The fitted feet Y is
  // remembered so the render loop can re-apply the idle driver's whole-body
  // vertical offset (the hop) from the anchor instead of accumulating it.
  rig.position.set(feetPx, feetPy);
  lastFitGeometry.feetX = feetPx;
  lastFitGeometry.feetY = feetPy;

  // Feed the idle driver the eye-line estimate (its resting gaze spots
  // center on it so the head sits LEVEL).
  updateEyeScreen();
}

/** Approximate screen position of the eyes (window px): her height minus a
 * fraction off the top for the head. Live2D rigs have no eye bones to query;
 * ~88% up her body is a stable estimate for the eye line across models. */
function updateEyeScreen() {
  if (!state.idle || !state.unitBounds || !state.rig) return;
  const eyeFrac = 0.88; // fraction of her height where the eyes sit
  const screenY = state.rig.position.y - state.unitBounds.height * state.rig.scale.y * eyeFrac;
  state.idle.setEyeScreen(state.rig.position.x, screenY);
}

/* ------------------------------------------------------------- hit-test --- */

/**
 * The model's fitted rect in window px, cached for the overlay's
 * hit-testing. The bounds are static per fit (the model may sway but her
 * envelope stays within the frame), so it recomputes on every fitModel —
 * no per-frame walk of the render tree.
 */
function updateCharacterRect() {
  const model = state.model;
  if (!model || !lastFitGeometry) {
    state.charRect = null;
    return;
  }
  const g = lastFitGeometry;
  const x = state.rig.position.x - g.widthPx / 2;
  const y = state.rig.position.y - g.heightPx;
  const width = g.widthPx;
  const height = g.heightPx;

  // Tighten the box a bit so clicks near transparent corners pass through.
  const insetX = width * 0.12;
  const insetTop = height * 0.06;
  state.charRect = {
    x: x + insetX,
    y: y + insetTop,
    width: width - insetX * 2,
    height: height - insetTop,
  };
}

/* -------------------------------------------------------------- loading --- */
// Models are parsed ONCE and kept resident in memory (modelCache): switching
// characters or restarting never re-downloads/re-parses — the Live2DModel
// (meshes, textures, GPU buffers) is simply re-attached, which is instant.
// After boot the remaining models are preloaded in the background so every
// switch is a zero-latency attach. This is what keeps the companion
// realtime-responsive.

const MODEL_CACHE_MAX = 4; // resident models before the oldest is evicted
const modelCache = new Map(); // rel -> { model, unitBounds }

/** Parse + prepare a Live2D model once: rig registration and bounds.
 * Post-load physics fallback: when the model3.json has no
 * FileReferences.Physics entry (so the runtime loaded none), fetch the
 * first *.physics3.json in the model folder (main-process IPC scan) and
 * attach a real SDK physics instance to the internal model — same
 * CubismPhysics.create the runtime itself uses, every group instantiated,
 * nothing filtered. */
async function buildModel(url, rel) {
  const model = await Live2DModel.from(url, {
    autoInteract: false, // pointer interactions are owned by the overlay
    autoUpdate: false, // the render loop drives updates (single ticker)
    motionPreload: 'IDLE', // the idle group (auto-idle material) preloads
    idleMotionGroup: 'idle', // our registered group name (framework
    // default is "Idle" with a capital I — the lookup is case-sensitive)
  });
  const im = model.internalModel;
  if (im && !im.physics && !im.settings?.json?.FileReferences?.Physics) {
    try {
      const found = await window.overlay?.findPhysics?.(rel);
      if (found && found.length) {
        const res = await fetch(im.settings.resolveURL(found[0]));
        if (res.ok) {
          const data = await res.json();
          im.physics = CubismPhysics.create(data);
          console.log(
            `[physics] ${rel}: no FileReferences.Physics — fallback loaded ${found[0]} (${data.PhysicsSettings?.length ?? 0} groups)`,
          );
        }
      } else {
        console.log(`[physics] no physics for ${rel}`);
      }
    } catch (err) {
      console.warn(`[physics] ${rel}: fallback load failed:`, err?.message ?? err);
    }
  }
  return { model, unitBounds: null };
}

/** Keep the cache bounded; never evict the model currently on stage. */
function cacheModel(rel, entry) {
  modelCache.set(rel, entry);
  if (modelCache.size > MODEL_CACHE_MAX) {
    for (const [key, value] of modelCache) {
      if (modelCache.size <= MODEL_CACHE_MAX) break;
      if (key === state.current) continue;
      modelCache.delete(key);
      value.model.destroy();
      console.log(`[vtuber] evicted cached model: ${key}`);
    }
  }
}

// In-flight builds, deduplicated by rel path: a tray switch/double-click can
// request a model that the background preload is already parsing, and two
// parallel buildModel runs for the same file would leave one full model
// (GPU buffers, textures) unreachable and never disposed.
const modelBuilds = new Map(); // rel -> Promise<entry>

function buildModelOnce(url, rel) {
  let build = modelBuilds.get(rel);
  if (!build) {
    build = buildModel(url, rel).finally(() => modelBuilds.delete(rel));
    modelBuilds.set(rel, build);
  }
  return build;
}

// Monotonic switch counter: a slow build must not attach its model after a
// NEWER switch has already been requested (last request wins, not last build).
let loadToken = 0;

/** Fetch + parse the per-model choreo-config.json (beside the model3.json)
 * — the shared config source for the choreo engine's signMap, the tail
 * idle hold, and the secondary layer's scale/sign/whip timing. Missing
 * file or parse failure returns {} (every consumer defaults sanely). */
async function loadChoreoConfig(rel, im) {
  try {
    const settings = im?.settings;
    if (!settings) return {};
    const res = await fetch(settings.resolveURL('choreo-config.json'));
    if (res.ok) return await res.json();
  } catch {
    /* no config — defaults stand */
  }
  return {};
}

/** Attach a (cached) Live2D model to the stage and rebuild the idle driver
 * for it. */
async function attachModel(entry, rel) {
  const { model } = entry;
  if (state.model === model) return;

  // Detach the previous model — it stays warm in the cache for instant reuse.
  if (state.model) {
    state.idle?.destroy();
    state.idle = null;
    state.secondary?.destroy();
    state.secondary = null;
    state.choreo?.destroy();
    state.choreo = null;
    state.rig.removeChildren();
  }
  // The rig carries the fitted position/scale; the model inside it is
  // anchored at her feet — whole-body idle animations (sways, rises) pivot
  // the rig transform around that anchor. Built once and reused across
  // model switches.
  state.rig = stage;

  state.model = model;
  state.current = rel;
  state.unitBounds = entry.unitBounds || null;
  applyRestTransform();
  state.rig.addChild(model);
  fitModel();

  state.idle = new IdleDriver(model);
  state.idle.setTrackMouse(state.trackMouse);
  // Secondary-language layer (ears/hair/skirt, post-physics additive):
  // created per attach from the model's own core, configured from the
  // same choreo-config.json the choreo engine reads (scale/signs/
  // whip timing), then handed to the driver — its clock advances in
  // the driver's applyFrame and its writes land in the pipeline
  // wrapper's post-physics slot.
  {
    const im = model.internalModel;
    if (im?.coreModel) {
      const cfg = await loadChoreoConfig(rel, im);
      // A model switch that landed in the await window above must not
      // bind this layer/engine onto the OTHER model's driver: the last
      // resolver would otherwise wire a stale pair. Bail and let the
      // newer attach own the slot.
      if (state.model !== model) return;
      state.secondary = new SecondaryLayer(im.coreModel, cfg);
      state.idle.setSecondary(state.secondary);
    } else {
      state.secondary = null;
    }
  }

  // The authored-animation engine: aliases, signMap, physics-ownership
  // guard and track library are (re)resolved per model — a reload or
  // switch gets a fresh engine bound to the new rig.
  state.choreo = new ChoreoEngine(model, rel);
  state.choreo.secondary = state.secondary; // secondary-event dispatch target
  state.idle.setChoreo(state.choreo);
  fitModel(); // pick up the eye-screen estimate now that the driver exists

  // If the bounds weren't measurable yet, keep retrying the fit over the
  // next frames until the measurement lands, so she never stays
  // mis-positioned. Capped: a model whose bounds never materialize must not
  // spin a retry loop forever in a 24/7 app.
  if (!state.unitBounds) {
    let attempts = 0;
    const retryFit = () => {
      if (state.model !== model) return; // a newer model replaced this one
      fitModel();
      if (!state.unitBounds) {
        if (++attempts < 240) {
          requestAnimationFrame(retryFit);
        } else {
          console.warn(`[vtuber] could not measure model bounds: ${rel}`);
        }
      }
    };
    requestAnimationFrame(retryFit);
  }

  console.log(
    `[vtuber] model ready: ${rel}` +
      (state.unitBounds
        ? ` ${state.unitBounds.width.toFixed(0)}x${state.unitBounds.height.toFixed(0)}`
        : ''),
  );
}

async function loadModel(url, rel, token) {
  let entry = modelCache.get(rel);
  if (entry) {
    console.log(`[vtuber] attaching resident model: ${rel}`);
  } else {
    console.log(`[vtuber] loading model: ${rel}`);
    entry = await buildModelOnce(url, rel);
    cacheModel(rel, entry);
  }
  if (token !== loadToken) return; // a newer switch superseded this load
  await attachModel(entry, rel);
}

/** Warm the cache with every remaining model, one at a time in the
 * background — after this, any tray switch is an instant attach. */
async function preloadAllModels() {
  for (const m of state.models) {
    if (modelCache.has(m.rel)) continue;
    try {
      const entry = await buildModelOnce(modelUrlFor(m.rel), m.rel);
      if (!modelCache.has(m.rel)) cacheModel(m.rel, entry);
      console.log(`[vtuber] preloaded model: ${m.rel}`);
    } catch (err) {
      console.warn(`[vtuber] preload failed for ${m.rel}:`, err);
    }
  }
}

async function switchModel(rel) {
  if (rel === state.current) return;
  // A tray switch can arrive before boot has populated the model list.
  if (!state.models.length) {
    try {
      const s = await window.overlay.getState();
      state.models = s.models;
    } catch {
      /* fall through — the check below will reject unknown models */
    }
  }
  if (!state.models.some((m) => m.rel === rel)) return;
  const token = ++loadToken;
  try {
    await loadModel(modelUrlFor(rel), rel, token);
  } catch (err) {
    console.error('[vtuber] failed to load model:', err);
  }
}

function cycleModel() {
  if (!state.models.length) return;
  const i = state.models.findIndex((m) => m.rel === state.current);
  const next = state.models[(i + 1) % state.models.length];
  // Go through the main process so tray state + persistence stay in sync;
  // the model is swapped when the change event comes back.
  window.overlay.setModel(next.rel);
}

function modelUrlFor(rel) {
  return `vtuber-model://local/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/* ------------------------------------------------------- overlay wiring --- */

// Two gaze feeds, each on its lowest-latency path:
//  - IN-WINDOW: this mousemove listener feeds the driver directly — no
//    IPC hop, no polling.
//  - OUT-OF-WINDOW: the main process streams the global cursor
//    (window-relative) over IPC; the driver ignores the stream while
//    mouse tracking is off.
window.addEventListener('mousemove', (e) => {
  state.idle?.setPointer(e.clientX, e.clientY);
});
window.overlay.onCursor(({ x, y }) => state.idle?.setPointer(x, y));

// Container/character edit modes. The window itself is the container:
// 'container' mode resizes/moves the actual window (bounds go to the main
// process in screen coords), 'character' mode moves her inside it. The
// character offset is stored as fractions of the window so it survives
// window resizes. Declared BEFORE the render loop and refit handler below,
// both of which call editUI.refresh() — module evaluation order must
// guarantee the binding exists when they run.
const editUI = setupEditMode({
  getRect: containerPx,
  getWindowBounds: () => ({
    x: window.screenX,
    y: window.screenY,
    w: window.innerWidth,
    h: window.innerHeight,
  }),
  onWindowBoundsChanged: (bounds) => window.overlay.setWindowBounds(bounds),
  getCharOffset: () => ({
    x: state.charOffset.x * window.innerWidth,
    y: state.charOffset.y * window.innerHeight,
  }),
  // Same visibility limits the rendering uses — keeps the drag symmetric
  // (the character never lags behind or detaches from the cursor).
  clampCharOffset: clampCharOffsetPx,
  onCharOffsetChanged: (off) => {
    state.charOffset = {
      x: off.x / window.innerWidth,
      y: off.y / window.innerHeight,
    };
    fitModel();
    window.overlay.setCharOffset(state.charOffset);
  },
});

/* ---------------------------------------------------------- render loop --- */

let lastNow = performance.now();
// The single ticker drives everything: idle driver → model update → render.
// autoUpdate=false on the model means the driver's parameter writes land in
// one deterministic order before the model's internal update runs, and
// Pixi's own render-on-tick is replaced by our explicit render() so nothing
// is drawn twice per frame. NOTE: TickerPlugin adds its render listener with
// the Application as context — remove() must pass the same context to match
// (fn-only removal silently fails and every frame would render twice).
app.ticker.remove(app.render, app);
app.ticker.add(() => {
  const now = performance.now();
  // Clamp delta so a paused/background window doesn't teleport the animations.
  // The clamp also guarantees dt is NEVER zero (the physics integration and
  // the mouse smoothing both divide/multiply through it).
  const delta = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000));
  lastNow = now;

  try {
    // Belt-and-braces resize handling: if the viewport (or DPI) differs from
    // what the fit assumes — which can happen when a minimize/maximize cycle
    // skips or reorders resize events — refit right now. This is what keeps the
    // character centered and fully visible after the window is restored.
    const W = window.innerWidth;
    const H = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    if (
      state.model &&
      W >= 8 &&
      H >= 8 &&
      (W !== lastFitW || H !== lastFitH || dpr !== lastFitDPR)
    ) {
      fitModel();
      editUI.refresh();
    }

    // Cursor tracking: normalized target update runs every frame regardless
    // of model state so the smoothed value keeps easing toward the pointer.
    state.idle?.applyFrame(delta);

    if (state.model) {
      // NOTE: Live2DModel.update() expects MILLISECONDS (the framework's own
      // ticker feeds it deltaMS). Passing seconds made physics run 1000× too
      // slow — every hair/cloth sway chain was effectively frozen.
      state.model.update(delta * 1000);
      // Whole-body offsets (hop rise/dip + choreo rigDx nudge): re-applied
      // from the fitted feet anchor every frame so they never accumulate or
      // fight the fit clamps (dy+ = up, dx+ = right on screen).
      if (lastFitGeometry) {
        state.rig.position.set(
          lastFitGeometry.feetX + (state.idle?.poseDx || 0),
          lastFitGeometry.feetY - (state.idle?.poseDy || 0),
        );
      }
    }
  } catch (err) {
    // One bad frame must not kill the always-on loop: log it (throttled)
    // and continue rendering the next frame. See reportFrameError above.
    reportFrameError(err);
  }
  app.render();
  updateCharacterRect();
  // Keep the emote panel's active-face / playing-move highlights live
  // (no-op when the panel is closed).
  refreshEmotePressed();
});

// Refit whenever the window/canvas changes size. Fit immediately, then again
// on the next frame so any layout settle is caught — the character must
// never drift or get the face cut off on maximize/restore. Focus and
// visibility changes cover restore-from-minimized cases where a resize event
// arrives late or not at all.
const refit = () => {
  fitModel();
  editUI.refresh();
  requestAnimationFrame(fitModel);
};
window.addEventListener('resize', refit);
window.addEventListener('focus', refit);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refit();
});

/* ------------------------------------------------------- overlay wiring --- */

// The tray can flip mouse tracking and edit modes too — stay in sync.
window.overlay.onStateChanged(({ trackMouse, editMode }) => {
  if (typeof trackMouse === 'boolean') {
    state.trackMouse = trackMouse;
    state.idle?.setTrackMouse(trackMouse);
  }
  if (typeof editMode === 'string') editUI.setMode(editMode);
});

setupOverlay({
  getCharacterRect: () => state.charRect,
  overEditUI: (x, y) => editUI.isOver(x, y),
  onCycleModel: cycleModel,
  onPoke: () => {
    // A poke = body reaction ONLY (hop/rock via the poke channel — no
    // face writes, no icon, no expression change; poke reactions were
    // stripped to their body-only form).
    state.idle?.poke();
  },
  onDoubleTap: () => state.idle?.dblGiggle(),
  onScale: (factor) => {
    state.scaleMul = Math.min(2.5, Math.max(0.4, state.scaleMul * factor));
    fitModel();
    // Persist the chosen size (fire-and-forget; the main process clamps
    // again on its side).
    window.overlay.setScaleMul?.(state.scaleMul);
  },
});

window.overlay.onModelChanged(({ rel }) => switchModel(rel));

/* --------------------------------------------------- expression+move panel ---
 * Popover off the toolbar's emote button. TWO sections, both calling the
 * SAME code paths as the keyboard map (single source of truth):
 *   Faces  — one button per .exp3 expression; click = setExpression;
 *            clicking the ACTIVE face again = normal.
 *   Moves  — choreo one-shots (nod/shake/look-back).
 * No icons anywhere: buttons are plain text labels, tooltips carry the
 * exact action names. The panel stays OPEN across picks (a face picker
 * that closes after every pick makes comparisons impossible); it closes
 * on any click outside it or the opener.
 * Part of the interactive surface (overlay.js overEmotePanel).
 */
// Assigned by the panel block below; the render loop calls it each frame so
// the active-face and currently-playing-move highlights stay live (a one-shot
// move un-highlights the moment it retires, without waiting for the next
// click). No-op when the panel is closed.
let refreshEmotePressed = () => {};
{
  const emoteBtn = document.getElementById('btn-emote');
  const panel = document.getElementById('emote-panel');
  const faces = panel.querySelector('.ep-faces');
  const moves = panel.querySelector('.ep-moves');

  // Faces: one button per expression, in library order. normal has no
  // keyboard key — it is reachable by re-clicking the active face.
  // Every face registered in model3.json needs an entry here, or it loads
  // but is unreachable (that was the devil/wink-left gap: both were
  // registered and parsed, yet had no panel button and no key, so
  // EXPRESSION_SECONDARY.devil was dead config as well).
  const FACE_ORDER = [
    'normal',
    'smile',
    'angry',
    'sad',
    'embarrassed',
    'sleepy',
    'love',
    'look-left',
    'look-right',
    'wink-left',
    'devil',
  ];
  const faceButtons = new Map();
  for (const name of FACE_ORDER) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ep-face';
    btn.dataset.expression = name;
    btn.setAttribute('aria-pressed', 'false'); // toggled in refreshPressed
    btn.textContent = name;
    btn.title = name === 'normal' ? 'normal (reset face)' : name;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Re-clicking the active face = normal; otherwise swap to it.
      const active = currentExpressionName();
      setExpressionByName(active === name && name !== 'normal' ? 'normal' : name);
      refreshPressed();
    });
    faces.appendChild(btn);
    faceButtons.set(name, btn);
  }

  // Moves: choreo one-shots. All through the same helpers the keyboard uses.
  const MOVE_ORDER = ['nod-yes', 'shake-no', 'look-back'];
  const moveButtons = new Map();
  for (const name of MOVE_ORDER) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ep-move';
    btn.dataset.choreo = name;
    btn.setAttribute('aria-pressed', 'false'); // toggled in refreshPressed
    btn.textContent = name;
    btn.title = name;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.choreo?.play(name);
      refreshPressed();
    });
    moves.appendChild(btn);
    moveButtons.set(name, btn);
  }

  // Pressed states + ARIA: the ACTIVE face (expression) is a persistent
  // selection (.pressed, filled accent); the currently-PLAYING move is a
  // transient action (.playing, outlined pulse) so the two read differently.
  // Both keep aria-pressed in sync so the state is machine-readable.
  function refreshPressed() {
    if (!panel.classList.contains('open')) return;
    const active = currentExpressionName();
    for (const [name, btn] of faceButtons) {
      const on = name === active;
      btn.classList.toggle('pressed', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    const playing = state.choreo?.active?.name ?? null;
    for (const [name, btn] of moveButtons) {
      const on = name === playing;
      btn.classList.toggle('playing', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }
  refreshEmotePressed = refreshPressed;

  function positionPanel() {
    // Anchor to the toolbar's left edge, aligned with the button row.
    const btn = emoteBtn.getBoundingClientRect();
    const winW = window.innerWidth;
    panel.style.right = `${Math.max(8, winW - btn.left + 10)}px`;
    panel.style.top = `${btn.top}px`;
  }

  function openPanel() {
    positionPanel();
    // Add 'open' BEFORE refreshPressed: refreshPressed early-returns while
    // the panel is closed, so this ordering applies the highlight/ARIA on
    // the very first frame instead of one render tick later.
    panel.classList.add('open');
    refreshPressed();
    emoteBtn.classList.add('active');
  }
  function closePanel() {
    panel.classList.remove('open');
    emoteBtn.classList.remove('active');
  }
  function togglePanel() {
    if (panel.classList.contains('open')) closePanel();
    else openPanel();
  }

  emoteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel();
  });
  // Any click outside the panel (and not on its opener) closes it.
  window.addEventListener('click', (e) => {
    if (!panel.classList.contains('open')) return;
    if (e.target instanceof Element && (panel.contains(e.target) || e.target.closest('#btn-emote')))
      return;
    closePanel();
  });
  // Keep it positioned with the toolbar on resizes.
  window.addEventListener('resize', () => {
    if (panel.classList.contains('open')) positionPanel();
  });
}

/* ------------------------------------------------- expression keying ---
 * Q..] swap .exp3 faces through the pixi expression manager (0.4 s
 * crossfades come from the files' FadeIn/FadeOut). ] = normal = the
 * default (empty) face, i.e. a full reset. Every registered face has a
 * key here — a face with a panel button but no key is only half-wired.
 */
const EXPRESSION_KEYS = {
  q: 'smile',
  e: 'angry',
  r: 'sad',
  u: 'embarrassed',
  i: 'love',
  o: 'wink-left',
  p: 'devil',
  '[': 'sleepy',
  ']': 'normal',
};

function setExpressionByName(name) {
  const em = state.model?.internalModel?.motionManager?.expressionManager;
  if (!em) return false;
  if (name === 'normal') {
    em.resetExpression();
    // SDK bookkeeping bug defense: resetExpression() swaps the QUEUE to
    // the default (empty) motion but leaves `currentExpression` pointing
    // at the PREVIOUS face. The stale pointer makes the NEXT
    // setExpression(<that same face>) trip its same-index guard and
    // silently no-op — the "icon over a neutral face" class of bug (the
    // face looks reset, but re-picking the same face does nothing).
    // Restore the invariant: current === default after a reset.
    em.currentExpression = em.defaultExpression;
    return true;
  }
  const idx = em.getExpressionIndex(name);
  if (idx < 0) return false;
  const p = em.setExpression(idx);
  if (p?.catch) p.catch(() => {});
  return true;
}

function currentExpressionName() {
  const em = state.model?.internalModel?.motionManager?.expressionManager;
  if (!em) return null;
  const cur = em.currentExpression;
  if (!cur || cur === em.defaultExpression) return 'normal';
  const idx = em.expressions.indexOf(cur);
  if (idx < 0) return null;
  return em.definitions[idx]?.Name ?? null;
}

/** Keyboard: choreo keys (1,2,L) + expression keys (Q..]). Only plain
 * keydowns (no repeats, no IME) while no edit mode owns the keyboard;
 * typing elsewhere is unaffected because the overlay window has no text
 * inputs. */
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  const choreoName = CHOREO_KEYS[key];
  if (choreoName) {
    state.choreo?.play(choreoName);
    return;
  }
  const exprName = EXPRESSION_KEYS[key];
  if (exprName) setExpressionByName(exprName);
});

(async () => {
  try {
    const { models, model, trackMouse, charOffset, scaleMul } = await window.overlay.getState();
    state.models = models;
    state.trackMouse = trackMouse !== false;
    if (Number.isFinite(scaleMul)) {
      state.scaleMul = Math.min(2.5, Math.max(0.4, scaleMul));
    }
    if (charOffset && Number.isFinite(charOffset.x) && Number.isFinite(charOffset.y)) {
      state.charOffset = charOffset;
    }
    console.log(`[vtuber] models found: ${models.map((m) => m.name).join(' | ') || '(none)'}`);
    if (model) await switchModel(model);
    else console.warn('[vtuber] no models found under ../character_models');
    // Warm the rest of the cache in the background — later switches attach
    // instantly instead of parsing mid-interaction.
    preloadAllModels();
  } catch (err) {
    console.error('[vtuber] boot failed:', err);
  }
})();
