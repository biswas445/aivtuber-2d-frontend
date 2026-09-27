/**
 * Authored animation engine ("choreo"): keyframed tracks for face, head,
 * body and special rig channels, applied as lerp-BLENDS inside the
 * physics.evaluate pipeline wrapper (see idle.js _applyPendingParams).
 *
 * Layering priority for FACE parameter ids, highest first:
 *   (1) choreo track with weight > 0  (lerp-blend overrides everything
 *       below it: base + (target - base) * weight, weight 1 = full
 *       override — cursor/procedural adds on the same id are absorbed
 *       by the lerp naturally),
 *   (2) active non-normal .exp3 expression (pixi expression manager),
 *   (3) procedural reaction writes (body-only poke reactions; the
 *       former EMOTES face system is DELETED),
 *   (4) rig defaults.
 * Blinks ALWAYS add on top (they run after the choreo application).
 *
 * Out of scope FOREVER: arm/hand/leg/foot animation — the rig has no
 * such parameters (see CAPABILITIES.md). No code may attempt runtime
 * arm/leg authoring.
 *
 * Special targets (not model parameters):
 *   rigDy — whole-rig vertical offset in screen px (+ = up), feeding
 *           the idle driver's poseDy hop channel;
 *   rigDx — whole-rig horizontal nudge in screen px (+ = right),
 *           clamped to +/-20 px, feeding a new poseDx channel.
 *
 * All clocks come from the ticker's dt (sample(delta) advances the
 * engine clock) — no timers anywhere. All parameter targets are
 * clamped to each parameter's authored min/max at resolution time
 * (the core clamps writes as well — belt and braces).
 */

import { AMBIENT_OWNED } from './secondary.js';

/* ------------------------------------------------------------- aliases ---
 * Character-facing alias -> real Cubism parameter id. Ids are
 * CHARACTER-SIDE per the rig's own labeling:
 *   ParamEyeROpen is LABELED 左眼 — the VIEWER-LEFT eye;
 *   ParamEyeLOpen is LABELED 右眼 — the VIEWER-RIGHT eye;
 *   the brows likewise (ParamBrowR* = viewer-left brow).
 * The eyeOpenViewerL/R aliases exist so a wink check can address the
 * eye as SEEN ON SCREEN without re-deriving that mapping.
 */
export const ALIASES = {
  headYaw: 'ParamAngleX',
  headPitch: 'ParamAngleY',
  headRoll: 'ParamAngleZ',
  bodyYaw: 'ParamBodyAngleX',
  bodyPitch: 'ParamBodyAngleY',
  bodyRoll: 'ParamBodyAngleZ',
  eyeBallX: 'ParamEyeBallX',
  eyeBallY: 'ParamEyeBallY',
  eyeOpenL: 'ParamEyeLOpen',
  eyeOpenR: 'ParamEyeROpen',
  eyeOpenViewerL: 'ParamEyeROpen',
  eyeOpenViewerR: 'ParamEyeLOpen',
  eyeSmileL: 'ParamEyeLSmile',
  eyeSmileR: 'ParamEyeRSmile',
  /* Viewer-side WINK aliases (official-viewer probing): 左眼微笑
   * (=ParamEyeRSmile) closes the VIEWER-LEFT eye in a happy arc; the
   * plain close is ParamEyeROpen. The aliases address the eye as SEEN
   * ON SCREEN so a wink reads on the intended side without re-deriving
   * the L/R flip. */
  winkViewerL: 'ParamEyeRSmile',
  winkViewerR: 'ParamEyeLSmile',
  closeViewerL: 'ParamEyeROpen',
  closeViewerR: 'ParamEyeLOpen',
  browLY: 'ParamBrowLY',
  browRY: 'ParamBrowRY',
  browLAngle: 'ParamBrowLAngle',
  browRAngle: 'ParamBrowRAngle',
  browLForm: 'ParamBrowLForm',
  browRForm: 'ParamBrowRForm',
  mouthOpen: 'ParamMouthOpenY',
  mouthForm: 'ParamMouthForm',
  tongue: 'TongueOut',
  smirk: 'MouthX',
  frown: 'Param2',
  blush: 'ParamCheek',
  blushAlt: 'Param57',
  faceShadow: 'Param56',
  heartEyes: 'Param58',
  tail: 'Param59',
  chestY1: 'Param22',
  chestY2: 'Param23',
  jellyL1: 'Param10',
  jellyR1: 'Param12',
  hemY1: 'Param28',
  hemY2: 'Param29',
  hemY3: 'Param47',
};

/* SIGNED aliases: their sign convention is model-specific, so a
 * per-model signMap (choreo-config.json beside the model3.json, all
 * default 1) multiplies every authored value. headYaw / eyeBallX /
 * eyeBallY are NOT here — their signs are verified by the working
 * cursor tracking (see the sign-convention note at the bottom of this
 * file). */
export const SIGNED_ALIASES = new Set([
  'headPitch',
  'headRoll',
  'bodyYaw',
  'bodyPitch',
  'bodyRoll',
  'browLY',
  'browRY',
  'browLAngle',
  'browRAngle',
  'browLForm',
  'browRForm',
  'mouthForm',
  'smirk',
  'frown',
]);

/* Special rig channels (never model parameters). */
const RIG_CLAMP = {
  rigDy: { min: -30, max: 40 },
  rigDx: { min: -20, max: 20 },
};

/* ------------------------------------------------------------- easing ---
 * Segment format (compact per-segment tuples, NOT the flat point list
 * Live2D's motion3.json exporter emits — motion3.json stores Curves as
 * one array of points per segment with an explicit segment-type count,
 * while this engine keeps each segment self-describing):
 *   [t0, v0, type, tEnd, vEnd]           types 0/1/2
 *   [t0, v0, 3, [cx1, cy1, cx2, cy2], tEnd, vEnd]
 * type 0 = step (hold v0 through the segment, vEnd lands at tEnd),
 * type 1 = linear, type 2 = easeInOut ≡ bezier (0.42,0)-(0.58,1),
 * type 3 = cubic-bezier with explicit control points.
 */
const EASE_IO = [0.42, 0, 0.58, 1];

function bezierY(cps, x) {
  const [x1, y1, x2, y2] = cps;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const fx = (t) => ((ax * t + bx) * t + cx) * t;
  const fy = (t) => ((ay * t + by) * t + cy) * t;
  const dfx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = fx(t) - x;
    if (Math.abs(err) < 1e-5) return fy(t);
    const d = dfx(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    t = (lo + hi) / 2;
    if (fx(t) < x) lo = t;
    else hi = t;
  }
  return fy((lo + hi) / 2);
}

/** Evaluate one curve's segment list at time t (seconds). Before the
 * first segment: its v0. After the last: the final vEnd (hold). */
export function evalCurve(segs, t) {
  if (!segs || !segs.length) return 0;
  if (t < segs[0][0]) return segs[0][1];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const isBezier = s[2] === 3;
    // type 3: [t0, v0, 3, [cps], tEnd, vEnd]; others: [t0, v0, type, tEnd, vEnd]
    const tEnd = isBezier ? s[4] : s[3];
    const vEnd = isBezier ? s[5] : s[4];
    if (t >= s[0]) {
      const span = tEnd - s[0];
      const u = span > 0 ? Math.min(1, Math.max(0, (t - s[0]) / span)) : 1;
      switch (s[2]) {
        case 0:
          return u >= 1 ? vEnd : s[1];
        case 1:
          return s[1] + (vEnd - s[1]) * u;
        default: {
          const cps = isBezier ? s[3] : EASE_IO;
          return s[1] + (vEnd - s[1]) * bezierY(cps, u);
        }
      }
    }
  }
  return segs[0][1];
}

/** Convert an ARRAY of keyframes into a segment list (the format evalCurve
 * consumes). Keyframes are [t, v, ease?]; `ease` describes the segment
 * ENDING at that keyframe: 'lin' linear, 'step' hold, 'in'/'out'/'io'
 * bezier presets, or [cx1, cy1, cx2, cy2]. Default 'io' (easeInOut). This
 * is the array form of the C() helper, so per-model config tracks (JSON)
 * can author curves the same way the built-ins do. */
function keyframesToSegments(kfs) {
  const segs = [];
  for (let i = 0; i < kfs.length - 1; i++) {
    const [t0, v0] = kfs[i];
    const [t1, v1, e] = kfs[i + 1];
    let type = 2;
    let cps = null;
    switch (e) {
      case 'step':
        type = 0;
        break;
      case 'lin':
        type = 1;
        break;
      case 'in':
        type = 3;
        cps = [0.42, 0, 1, 1];
        break;
      case 'out':
        type = 3;
        cps = [0, 0, 0.58, 1];
        break;
      case 'io':
      case undefined:
        type = 2;
        break;
      default:
        if (Array.isArray(e)) {
          type = 3;
          cps = e;
        }
    }
    if (cps) segs.push([t0, v0, 3, cps, t1, v1]);
    else segs.push([t0, v0, type, t1, v1]);
  }
  return segs;
}

/** Authoring helper: spread keyframes -> segment list (see keyframesToSegments). */
function C(...kfs) {
  return keyframesToSegments(kfs);
}

/* ------------------------------------------------------------ library --- */
/* All tracks authored via ALIASES only; values are sign-mapped and
 * clamped at resolution. Loopables carry loop + fade times; one-shots
 * get a default 0.08 s fade-in / 0.25 s release envelope applied by
 * the engine. */

export const TRACKS = {
  /* --- core ------------------------------------------------------------ */
  // Nod: head-ONLY (viewer probing: 角度Y is amplitude-hungry — 14 reads
  // clearly, and the torso must stay out of it). Sign-calibrated via
  // signMap (headPitch); the FIRST key is DOWN (−14: ParamAngleY+ is
  // pitch UP per the verified sign convention), then the small recoil
  // up, then a softer down, then rest.
  'nod-yes': {
    duration: 1.4,
    curves: {
      headPitch: C([0, 0], [0.35, -14], [0.7, 4], [1.05, -10], [1.4, 0]),
    },
  },
  // Shake: head ±12 with a ±3 body counter-yaw (the shoulders read
  // "no" too, opposing the head); hairWhip(6) fires at each direction
  // change through the secondary layer (post-physics additive).
  'shake-no': {
    duration: 1.5,
    curves: {
      headYaw: C([0, 0], [0.3, -12], [0.7, 12], [1.1, -9], [1.5, 0]),
      headRoll: C([0, 0], [0.3, 4], [0.7, -4], [1.1, 3], [1.5, 0]),
      bodyYaw: C([0, 0], [0.3, 3], [0.7, -3], [1.1, 2.25], [1.5, 0]),
    },
    secondary: [
      { op: 'hairWhip', t: 0.3, amp: 6, dir: 1 },
      { op: 'hairWhip', t: 0.7, amp: 6, dir: -1 },
      { op: 'hairWhip', t: 1.1, amp: 6, dir: 1 },
    ],
  },
  /* --- specials -------------------------------------------------------- */
  /* (No loopables: the framework itself auto-plays the idle group's
   * idle-sway.motion3.json as the perpetual background loop — a track
   * here would be a second, competing copy of the same animation.) */
  /* --- gestures -------------------------------------------------------- */
  'look-back': {
    duration: 3.2,
    curves: {
      // Look back over the RIGHT shoulder, then swing back over the LEFT,
      // then settle to center — she checks both sides.
      headYaw: C(
        [0, 0],
        [0.5, 25],
        [1.1, 25],
        [1.4, 0],
        [1.9, -25],
        [2.5, -25],
        [3.0, 0],
        [3.2, 0],
      ),
      bodyYaw: C([0, 0], [0.5, 6], [1.1, 6], [1.4, 0], [1.9, -6], [2.5, -6], [3.0, 0], [3.2, 0]),
      eyeBallX: C(
        [0, 0],
        [0.4, 0.8],
        [1.1, 0.8],
        [1.4, 0],
        [1.9, -0.8],
        [2.5, -0.8],
        [3.0, 0],
        [3.2, 0],
      ),
      headRoll: C([0, 0], [0.5, -4], [1.1, -4], [1.4, 0], [1.9, 4], [2.5, 4], [3.0, 0], [3.2, 0]),
    },
    secondary: [
      // hair trails each turn and whips back as she swings to the other side.
      // Amplitudes are LOW on purpose: the ±25° head swing already drives a
      // strong physics follow-through on the hair chain, so a large additive
      // hairWhip would double-drive it and read as the hair snapping around
      // fast and independently of the head. Dur is also longer (slower rise)
      // so the hair eases into the trail instead of flicking.
      { op: 'hairWhip', t: 0.5, amp: 4, dir: -1, dur: 0.75 },
      { op: 'hairWhip', t: 1.4, amp: 3, dir: 1, dur: 0.6 },
      { op: 'hairWhip', t: 1.9, amp: 4, dir: 1, dur: 0.75 },
      { op: 'hairWhip', t: 3.0, amp: 3, dir: -1, dur: 0.6 },
    ],
  },
};

/* Keyboard map (choreo half; expression keys live in main.js). Keys
 * 3, 4, 6, 8, 9, 0, H, B, V and C are retired: the choreos they used
 * to trigger (hip-sway, bounce-happy, talk-loop, calib-axes, ...) were
 * deleted; the keys do nothing now. */
export const CHOREO_KEYS = {
  1: 'nod-yes',
  2: 'shake-no',
  l: 'look-back',
};

/* -------------------------------------------------------------- engine --- */

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export class ChoreoEngine {
  /**
   * @param {import('pixi-live2d-display').Live2DModel} model Loaded model.
   * @param {string} rel Model rel path (logs).
   */
  constructor(model, rel) {
    this.model = model;
    this.rel = rel;
    this.now = 0; // engine clock (seconds, from ticker dt only)
    this.active = null; // { name, def, t0, stopAt }
    this.fading = null; // crossfading-out previous track
    this.destroyed = false;
    /** Per-model track library: built-ins plus (later) overrides/additions
     * from choreo-config.json `tracks` (see _loadTracks). play() reads this,
     * never the static TRACKS directly, so moves are tunable per model
     * without a rebuild. */
    this.tracks = { ...TRACKS };

    const core = model.internalModel?.coreModel;
    this._count = core ? core.getParameterCount() : 0;
    /** alias|rawId|rigDy|rigDx -> { id, index, min, max, sign } */
    this._resolved = {};
    /** physics-owned parameter ids — NEVER authored (guard). */
    this._owned = new Set();
    this._signMap = {}; // alias -> -1 | 1 (signed aliases only)

    this._resolveAliases();
    this._collectOwned();
    this._loadSignMap();
    this._loadTracks();
  }

  /* ---------------------------------------------- load-time resolution --- */

  _resolveAliases() {
    const core = this.model.internalModel?.coreModel;
    const unresolved = [];
    const seenIds = new Set(); // log each real id once even when two aliases share it
    for (const [alias, id] of Object.entries(ALIASES)) {
      if (!core) {
        unresolved.push(alias);
        continue;
      }
      const i = core.getParameterIndex(id);
      if (i < 0 || i >= this._count) {
        unresolved.push(alias);
        continue;
      }
      if (!seenIds.has(id)) {
        seenIds.add(id);
        this._resolved[id] = {
          id,
          index: i,
          min: core.getParameterMinimumValue(i),
          max: core.getParameterMaximumValue(i),
          sign: 1,
        };
      }
      // Both eyeOpen aliases point at the same ids; alias resolution
      // maps through the id entry at play time (see _resolveKey).
      this._resolved[alias] = this._resolved[id];
    }
    for (const key of ['rigDy', 'rigDx']) {
      this._resolved[key] = { id: key, index: -1, ...RIG_CLAMP[key], sign: 1 };
    }
    const n = Object.keys(ALIASES).length;
    console.log(
      `[choreo] ${this.rel}: aliases resolved ${n - unresolved.length}/${n}` +
        (unresolved.length
          ? ` — MISSING: ${unresolved.join(', ')} (tracks using them are skipped)`
          : ''),
    );
  }

  /** Physics3.json output ids from the LIVE SDK instance (the single
   * source of truth for what physics owns — matches the authored file:
   * hair Param5/6/7, cloth Param25/26/27, ears Param3/54/55/4/36/37/
   * 38/39/40, breath rotations Param_Angle_Rotation_*_ArtMesh159/160). */
  _collectOwned() {
    const rig = this.model.internalModel?.physics?._physicsRig;
    if (rig?.outputs && rig.settings) {
      for (let s = 0; s < rig.settings.length; s++) {
        const setting = rig.settings[s];
        for (let o = 0; o < setting.outputCount; o++) {
          const id = rig.outputs[setting.baseOutputIndex + o]?.destination?.id;
          if (id) this._owned.add(id);
        }
      }
    }
    // Ambient-drift chains (ambientSway): skirt x/y, hair, ornaments,
    // headpiece are owned by the ambient channel (post-physics additive
    // / direct idle writes) — plain choreo/exp3 authoring on them is
    // refused exactly like physics-owned ids (a track curve on an
    // ambient id would fight the always-on drift every frame).
    for (const id of AMBIENT_OWNED.keys()) this._owned.add(id);
    console.log(
      this._owned.size
        ? `[choreo] ${this.rel}: physics/ambient-owned ids (never authored): ${[...this._owned].sort().join(', ')}`
        : `[choreo] ${this.rel}: WARNING no physics instance — ownership guard inactive`,
    );
  }

  /** Per-model signMap from choreo-config.json beside the model3.json
   * ({ "signMap": { "headPitch": -1, ... } }); every signed alias
   * defaults to +1. Re-resolved on every model load (new engine). */
  async _loadSignMap() {
    this._signMap = {};
    for (const a of SIGNED_ALIASES) this._signMap[a] = 1;
    try {
      const settings = this.model.internalModel?.settings;
      const res = await fetch(settings.resolveURL('choreo-config.json'));
      if (res.ok) {
        const data = await res.json();
        let applied = 0;
        for (const [alias, sign] of Object.entries(data?.signMap || {})) {
          if (SIGNED_ALIASES.has(alias) && (sign === 1 || sign === -1)) {
            this._signMap[alias] = sign;
            applied++;
          }
        }
        console.log(
          `[choreo] ${this.rel}: choreo-config.json signMap — ${applied} override(s)` +
            (applied
              ? `: ${
                  Object.entries(this._signMap)
                    .filter(([, v]) => v === -1)
                    .map(([k]) => k)
                    .join(', ') || 'none flipped'
                }`
              : ''),
        );
        return;
      }
    } catch {
      /* no config file — defaults (all +1) stand */
    }
    console.log(
      `[choreo] ${this.rel}: no choreo-config.json — signMap defaults (+1) for all signed aliases`,
    );
  }

  /** Per-model track library from choreo-config.json: an optional `tracks`
   * map (track-name -> definition) MERGES over the built-in TRACKS by name —
   * overriding an existing track wholly or partially (a config track that
   * omits `curves` for an alias keeps the built-in curve for that alias) and
   * adding brand-new tracks. Config curves are authored as KEYFRAME arrays
   * ([t, v, ease?], the same input the C() built-in helper takes) and are
   * converted to segments here. Re-resolved on every model load (new engine),
   * so a config edit takes effect on the next attach without a rebuild. */
  async _loadTracks() {
    try {
      const settings = this.model.internalModel?.settings;
      const res = await fetch(settings.resolveURL('choreo-config.json'));
      if (!res.ok) return;
      const data = await res.json();
      const tracks = data?.tracks;
      if (!tracks || typeof tracks !== 'object') return;
      let applied = 0;
      for (const [name, cfgTrack] of Object.entries(tracks)) {
        if (!name || !cfgTrack || typeof cfgTrack !== 'object') continue;
        const base = this.tracks[name] || {};
        const curves = base.curves ? { ...base.curves } : {};
        if (cfgTrack.curves && typeof cfgTrack.curves === 'object') {
          for (const [alias, kfs] of Object.entries(cfgTrack.curves)) {
            if (Array.isArray(kfs)) curves[alias] = keyframesToSegments(kfs);
          }
        }
        this.tracks[name] = { ...base, ...cfgTrack, curves };
        applied++;
      }
      if (applied)
        console.log(
          `[choreo] ${this.rel}: loaded ${applied} config track(s) from choreo-config.json`,
        );
    } catch {
      /* no config — built-in TRACKS stand */
    }
  }

  /* --------------------------------------------------------- guarding --- */

  /** True when a curve target is authorable: resolves (alias, raw id,
   * or rig channel) and is not physics-owned. Logs every refusal. */
  _authorizeCurve(key) {
    if (key === 'rigDy' || key === 'rigDx') return true;
    // Every other _resolved entry has index >= 0 (real ids and their
    // aliases in _resolveAliases; only rigDy/rigDx carry index -1 and
    // those already returned above), so a single index test is
    // sufficient — a second "shared entry" test here was unreachable.
    const entry = this._resolved[key];
    const id = ALIASES[key] || (entry && entry.index >= 0 ? key : null);
    if (!id) {
      console.warn(`[choreo] ${this.rel}: curve "${key}" unresolved — skipped`);
      return false;
    }
    if (this._owned.has(id)) {
      console.warn(`[choreo] ${this.rel}: REFUSED "${key}" -> ${id} is physics-owned — skipped`);
      return false;
    }
    return true;
  }

  /** Filter a track's curves through the guard; null when nothing
   * authorable remains (track skipped with a warning). */
  _authorizeTrack(name, def) {
    const curves = {};
    for (const [key, segs] of Object.entries(def.curves || {})) {
      if (this._authorizeCurve(key)) curves[key] = segs;
    }
    if (!Object.keys(curves).length) {
      console.warn(`[choreo] ${this.rel}: track "${name}" has no authorable curves — skipped`);
      return null;
    }
    return curves;
  }

  /* ---------------------------------------------------------- playback --- */

  /** Start a track by name (replaces whatever is playing with a short
   * crossfade). Returns false for unknown/unauthorable tracks. */
  play(name) {
    const def = this.tracks[name];
    if (!def) return false;
    const curves = this._authorizeTrack(name, def);
    if (!curves) return false;
    if (this.active) this._retire(this.active);
    this.active = {
      name,
      def,
      curves,
      // Secondary event bookkeeping: firedOnce flags per event index,
      // reset at play (loop wraps re-fire every cycle).
      secondaryFired: def.secondary ? new Array(def.secondary.length).fill(false) : null,
      secondaryLoops: 0,
      t0: this.now,
      stopAt: null,
    };
    return true;
  }

  /** Crossfade out and retire the active track (loopables stop here). */
  stop() {
    if (this.active) {
      this._retire(this.active);
      // The retired track lives on ONLY in `fading` for its release
      // envelope — `active` must clear immediately, or current()
      // keeps reporting the stopped track forever (and a loop's
      // curves keep a permanent partial weight through the lerp).
      this.active = null;
    }
  }

  _retire(track) {
    const dur = Math.max(0.05, track.def.fadeOut ?? 0.25);
    track.stopAt = this.now;
    track.stopDur = dur;
    this.fading = track;
  }

  destroy() {
    this.destroyed = true;
    this.active = null;
    this.fading = null;
  }

  /* ------------------------------------------------------------ sample --- */
  /**
   * Advance the engine clock by dt (seconds) and evaluate the active
   * (+ fading) track.
   * @returns {Map<string, {target:number, weight:number}>} keyed by
   * REAL parameter id — plus special 'rigDy' / 'rigDx' entries for the
   * renderer-side rig channels.
   */
  sample(dt) {
    this.now += dt;
    const out = new Map();
    if (this.fading) {
      const p = (this.now - this.fading.stopAt) / this.fading.stopDur;
      if (p >= 1) this.fading = null;
      else this._sampleTrack(this.fading, out, 1 - p);
    }
    if (this.active) {
      this._sampleTrack(this.active, out, 1);
      if (!this.active.def.loop) {
        const end = this.now - this.active.t0;
        const over = end - this.active.def.duration;
        const fadeOut = this.active.def.fadeOut ?? 0.25;
        if (over > fadeOut + 0.05) this.active = null; // fully released
      }
    }
    return out;
  }

  _sampleTrack(track, out, fadeMul) {
    const def = track.def;
    const t = this.now - track.t0;
    // Track weight: fadeIn envelope; loops run until stopped (their
    // release comes through fadeMul), one-shots release after the
    // duration over fadeOut.
    let w = 1;
    const fadeIn = def.fadeIn ?? 0.08;
    if (fadeIn > 0 && t < fadeIn) w = Math.min(1, t / fadeIn);
    if (!def.loop) {
      const over = t - def.duration;
      const fadeOut = def.fadeOut ?? 0.25;
      if (over > 0) w = Math.min(w, Math.max(0, 1 - over / fadeOut));
    }
    w *= fadeMul;
    if (w <= 0.0005) return;

    const tw = def.loop ? t % def.duration : t;

    // Previous-cycle clock for the crossing tests below. This MUST be
    // captured as a LOCAL and the field updated ONCE, here: reading
    // track.lastTw after it was already assigned `tw` compares `tw`
    // against itself, so every crossing test (and the `tw < lastTw`
    // wrap test) is trivially false and no event/mark ever fires. That
    // was the shake-no/look-back hairWhip bug — the assignment used to
    // sit between the marks block and the secondary block, so the
    // secondary block always saw the just-written current value.
    const lastTw = track.lastTw;
    track.lastTw = tw;

    // Marks: fire when this track's (loop-aware) clock crosses mark.t.
    // Loop wrap-around counts as a crossing for any un-fired mark of
    // the PREVIOUS cycle (a mark at t > lastTw fires at the wrap).
    if (def.marks?.length && lastTw !== undefined) {
      for (const mark of def.marks) {
        let crossed = lastTw <= mark.t && tw > mark.t;
        if (!crossed && def.loop && tw < lastTw) {
          crossed = mark.t > lastTw || mark.t <= tw; // wrapped
        }
        if (crossed) this._fireMark(track, mark);
      }
    }

    // Secondary events (secondary.js): one-shot pulses at authored
    // times on the track's (loop-aware) clock — e.g. hairWhip(6) fired
    // at each shake-no direction change. Fired through the same
    // crossing/wrap discipline as marks; loop wraps re-arm the flags.
    if (def.secondary?.length && track.secondaryFired && lastTw !== undefined) {
      for (let i = 0; i < def.secondary.length; i++) {
        const ev = def.secondary[i];
        let crossed = lastTw <= ev.t && tw > ev.t;
        if (!crossed && def.loop && tw < lastTw) {
          crossed = ev.t > lastTw || ev.t <= tw; // wrapped
        }
        if (crossed && !track.secondaryFired[i]) {
          track.secondaryFired[i] = true;
          this._fireSecondary(track, ev, tw);
        }
      }
      if (def.loop && tw < lastTw) {
        // new cycle: re-arm all flags for the next pass
        track.secondaryFired.fill(false);
      }
    }

    for (const [key, segs] of Object.entries(track.curves)) {
      const entry = this._resolveKey(key);
      if (!entry) continue;
      let v = evalCurve(segs, tw) * entry.sign;
      v = clamp(v, entry.min, entry.max);
      const prev = out.get(entry.id);
      if (!prev || prev.weight <= 0.0005) {
        out.set(entry.id, { target: v, weight: w });
      } else {
        // Crossfade blend between outgoing and incoming tracks.
        const sw = prev.weight + w;
        out.set(entry.id, {
          target: (prev.target * prev.weight + v * w) / sw,
          weight: Math.max(prev.weight, w),
        });
      }
    }
  }

  _fireMark(track, mark) {
    console.log(`[choreo] ${track.name} ${mark.label ?? ''}`.trimEnd());
  }

  /** Fire one secondary event through the attached SecondaryLayer (set
   * by the renderer per attach; a track with `secondary` on a model
   * without the layer no-ops gracefully). Event shape:
   *   { op: 'hairWhip'|'skirtWhip'|'skirtFidget'|'earFlick'|'earSplay'|
   *         'earDroop'|'earPrick',
   *     t, amp, dir?, ear?, dur?, cycles?, perEar? } */
  _fireSecondary(track, ev) {
    const layer = this.secondary;
    if (!layer || layer.destroyed) return;
    switch (ev.op) {
      case 'hairWhip':
        layer.hairWhip(ev.amp, ev.dir ?? 1, ev.dur);
        break;
      case 'skirtWhip':
        layer.skirtWhip(ev.amp, ev.dir ?? 1);
        break;
      case 'skirtFidget':
        layer.skirtFidget(ev.amp, ev.cycles ?? 2);
        break;
      case 'earFlick':
        layer.earFlick(ev.ear ?? 'L', ev.amp, ev.dur ?? 0.5);
        break;
      case 'earSplay':
        layer.earSplay(ev.amp);
        break;
      case 'earDroop':
        layer.earDroop(ev.amp, ev.perEar ?? null, ev.dur ?? 0.3);
        break;
      case 'earPrick':
        layer.earPrick(ev.amp, ev.dur ?? 0.22);
        break;
      default:
        console.warn(`[choreo] ${track.name}: unknown secondary op "${ev.op}"`);
    }
  }

  /** Curve key (alias / raw id / rig channel) -> resolved entry with
   * sign (signMap for signed aliases) — or null. */
  _resolveKey(key) {
    if (key === 'rigDy' || key === 'rigDx') return this._resolved[key] ?? null;
    const id = ALIASES[key];
    const entry = id ? this._resolved[id] : this._resolved[key];
    if (!entry || entry.index < 0) return null;
    const sign = SIGNED_ALIASES.has(key) ? (this._signMap[key] ?? 1) : 1;
    return { ...entry, sign };
  }
}

/* --------------------------------------------- sign convention (report) ---
 * updateCursorTracking (idle.js), verified live on this rig:
 *   mouseX +1 = cursor at the window's RIGHT edge  -> ParamAngleX
 *   goes POSITIVE and the head turns toward the viewer's RIGHT;
 *   mouseY +1 = cursor at the window's TOP edge (screen y is flipped)
 *   -> ParamAngleY POSITIVE = head pitches UP. ParamEyeBallX/Y follow
 *   the same axes at gain 1. So: +x = viewer-right, +y = viewer-up.
 * headYaw / eyeBallX / eyeBallY are therefore sign-verified and NOT
 * sign-mapped; the other signed aliases stay configurable per model
 * (choreo-config.json signMap) until their directions are confirmed.
 */
