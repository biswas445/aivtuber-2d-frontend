/**
 * Idle behavior driver for Live2D Cubism companions: everything that keeps
 * her alive between interactions. Cubism models ship with their own
 * internal update pipeline (motions → expressions → eye-blink → focus →
 * physics → pose); this driver writes STANDARD Cubism parameter IDs
 * (ParamAngleX/Y/Z, ParamEyeBallX/Y, ParamEyeLOpen/ROpen, ...) through the
 * core model with additive layering, so whatever the rig actually owns
 * moves, and missing parameters are simply no-ops.
 *
 * What it does:
 *
 * - Always-on signs of life: a soft breathing bob (ParamBreath when the rig
 *   has it, else a body-rise), a slow micro sway through ParamBodyAngleX/Z,
 *   and two slow incommensurate head micro-drifts, so she is never
 *   perfectly still. Blinks always close BOTH eyes together from a single
 *   shared value — the driver never closes one eye on its own.
 * - Reactions to being poked (clicked on): a quick giggle, startled
 *   double-take, curious head tilt, or a little hop.
 *
 * Gaze: with mouse tracking enabled she follows the cursor (in-window
 * positions arrive through the renderer's own mousemove — zero latency —
 * and out-window ones through the main-process cursor stream) and even
 * steals the occasional glance away so she doesn't stare; with it disabled
 * the cursor is ignored entirely and she wanders around on her own using
 * saccade-like hops between resting spots. The head follows the gaze with
 * a damped lag — eyes lead, head follows (ParamEyeBallX/Y carry the eyes,
 * ParamAngleX/Y the head). At rest the head sits LEVEL: resting gaze spots
 * center on her own eye line, so she looks straight at the viewer instead
 * of dipping her chin.
 */

import { AMBIENT_CHAINS } from './secondary.js';

// ---- timing constants -------------------------------------------------------

const BLINK_CLOSE_MS = 90;
const BLINK_HOLD_MS = 50;
const BLINK_OPEN_MS = 190;
// How long the model keeps looking at the cursor's last position after it
// stops moving, before she starts glancing around on her own.
const WANDER_AFTER_MS = 3500;
// When a poke interrupts an action, the interrupted action keeps
// contributing while it decays over this window (crossfaded with the
// reaction), so nothing ever snaps in a single frame.
const POKE_FADE_MS = 280;

/* ------------------------------------------ expression secondary table ---
 * Continuous secondary-chain offsets per ACTIVE expression (the
 * "body language" half of every face; values from the official-viewer
 * slider-probing session): keys are layer offset channels, values in
 * chain units. Everything scales with the expression's LIVE fade
 * weight (0.4 s crossfade — read from the SDK expression queue), so a
 * face's ears rise/droop WITH the face, not after it.
 *   droop   — earDroop base offset (both ears), ear units
 *   prick   — earPrick base offset (opposite of droop), ear units
 *   splay   — earSplay base offset, splay units
 *   oneEar  — 'L' | 'R' | null: prick applies to ONE ear (devil)
 *   wave    — slow ear sway { amp, period, phase }: both ears bend gently
 *             back and forth (period in ms, ~0.8 Hz), right ear phase-shifted
 *             so they read as a soft anime "waving" instead of a fast jitter.
 *             (Replaces the former 6 Hz tremble — that read as nervous
 *             vibrating, not a wave.)
 *   fidget  — { amp, cycles }: skirtFidget refire cadence while held
 *             (embarrassed nervous hem): refires every 2.4 s
 *   flick   — love: alternating per-ear flicks every 0.7-1.3 s while held
 * Expressions not listed read as all-zero (others = 0 per spec).
 */
const EXPRESSION_SECONDARY = {
  smile: { prick: 3 },
  angry: { droop: 8 }, // stiff — holds flat, no wave
  sad: { droop: 10 },
  embarrassed: {
    droop: 4,
    wave: { amp: 4, period: 1300, phase: 0.55 },
    fidget: { amp: 3, cycles: 2 },
  },
  sleepy: { droop: 7 },
  love: { flick: true },
  devil: { oneEar: 'L', prick: 4 },
  normal: {},
};

// Cursor tracking — parity with the official Cubism viewer / SDK sample
// (LAppModel.update): the cursor is normalized to [-1, 1] around the
// WINDOW center (center = 0,0; +1 = right/top edge), smoothed with the
// sample's exponential easing (0.15 per frame at 60 fps, expressed as a
// rate so the feel is identical at any refresh rate), then ADDED to the
// parameters after the motion update with the sample's gains:
//   ParamAngleX     += mouseX * 30
//   ParamAngleY     += mouseY * 30
//   ParamBodyAngleX += mouseX * 10
//   ParamEyeBallX   += mouseX * 1
//   ParamEyeBallY   += mouseY * 1
// Every write is has()-gated (only IDs the rig owns) and the core clamps
// each write to the parameter's own min/max.
const MOUSE_SMOOTH_RATE = -Math.log(1 - 0.15) * 60; // ≈9.73/s == 0.15/frame @60fps
const HEAD_YAW_GAIN = 30; // deg at mouseX = ±1 (viewer gain)
const HEAD_PITCH_GAIN = 30; // deg at mouseY = ±1
const BODY_YAW_GAIN = 10; // torso lean at mouseX = ±1
// Second-stage head damping: the eyes lead and the head settles just behind
// them. ~6/s keeps the head turn visibly gradual (NOT a snap) while still
// responsive — a faster rate made follow/unfollow head turns read as
// instant, which is what the camera catches as "she just turned her head."
const HEAD_FOLLOW_RATE = 6.0; // exponential damping rate (1/s)
// Maximum angular velocity of the head follow (deg/s). Exponential easing
// alone is PROPORTIONAL — it moves fastest when the error is largest, so a
// big swing (cursor teleport, follow-in from a far wander spot, the
// return-to-rest on the timeout unfollow, a glance/wander look-away) used
// to cover the whole range in ~0.3s and read as an instant head-snap. This
// cap bounds how fast the head can ever turn: large corrections glide at a
// graceful constant pace (then the exponential eases out the tail), while
// small in-range cursor corrections stay responsive because they never hit
// the cap. Both the follow-in and the timeout unfollow now read as slow,
// deliberate turns.
const HEAD_TURN_RATE = 60; // deg/s cap on head yaw/pitch follow
// Smooth cursor engagement (0..1): ramps up while the pointer is being
// updated and back down after it goes stale, so the follow <-> wander
// boundary is a gradual ease instead of a discrete boolean switch (which
// snapped the head the instant the cursor stopped or resumed).
const FOLLOW_ENGAGE_RATE = 2.5; // exponential ramp rate (1/s)
// Neutral head pitch: exactly LEVEL.
const NEUTRAL_HEAD_PITCH = 0;
// Hard limits for the composed head rotation — gestures may overshoot the
// tracking range; the core clamps per-parameter anyway.
const HEAD_PITCH_HARD_MIN = -30;
const HEAD_PITCH_HARD_MAX = 30;
const HEAD_YAW_HARD_MAX = 30;
// Non-pointer gaze targets (idle wander) run through the same pipeline
// scaled down, so rest reads calm instead of sweeping.
const GAZE_WANDER_SCALE = 0.35;

function smoothstep(a, b, t) {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeInQuad = (t) => t * t;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Keep a resting gaze spot (window px y) inside a comfortable vertical
 * range even when the eyes sit near a window edge. */
function clampGazeSpotY(y, h) {
  return Math.min(h * 0.9, Math.max(h * 0.08, y));
}

/** Blend an interrupted action's bucket into the current frame's bucket:
 * every channel the old action wrote becomes old*wOld + current*(1-wOld) —
 * a true crossfade, so the hand-off can never snap. Channels only the new
 * action writes are untouched; channels only the old one wrote decay to 0. */
function mergeBucket(dst, src, wOld) {
  const wNew = 1 - wOld;
  for (const key of Object.keys(src)) {
    const value = src[key];
    if (typeof value !== 'number') continue;
    dst[key] = value * wOld + (dst[key] || 0) * wNew;
  }
}

// Standard parameter id sets, resolved per model (present-ids only).
const P = {
  headX: 'ParamAngleX',
  headY: 'ParamAngleY',
  headZ: 'ParamAngleZ',
  eyeX: 'ParamEyeBallX',
  eyeY: 'ParamEyeBallY',
  eyeLOpen: 'ParamEyeLOpen',
  eyeROpen: 'ParamEyeROpen',
  eyeLSmile: 'ParamEyeLSmile',
  eyeRSmile: 'ParamEyeRSmile',
  browLY: 'ParamBrowLY',
  browRY: 'ParamBrowRY',
  browLAngle: 'ParamBrowLAngle',
  browRAngle: 'ParamBrowRAngle',
  mouthOpen: 'ParamMouthOpenY',
  mouthForm: 'ParamMouthForm',
  mouthX: 'MouthX',
  frown: 'Param2',
  blush: 'Param57',
  heartEyes: 'Param58',
  darkFace: 'Param56',
  tongue: 'TongueOut',
  cheekPuff: 'CheekPuff',
  tail: 'Param59',
  bodyX: 'ParamBodyAngleX',
  bodyY: 'ParamBodyAngleY',
  bodyZ: 'ParamBodyAngleZ',
  breath: 'ParamBreath',
};

// NOTE: secondary motion (hair, ears, sleeves, ribbons, tails) comes from
// the model's own physics3.json via the SDK physics instance — the single
// source of truth, exactly like the official viewer. The always-on
// gentle cloth/hair/ornament drift in the default idle is the AMBIENT
// channel (ambientSway in secondary.js) — additive on top of physics,
// never a replacement.

export class IdleDriver {
  /**
   * @param {import('pixi-live2d-display').Live2DModel} model The loaded model.
   */
  constructor(model) {
    this.model = model;

    // Parameter index/existence cache: resolve each standard id's INDEX
    // once (through the wrapper's getParameterIndex) and reuse it every
    // frame. An index >= getParameterCount() means the rig doesn't have
    // the id (the wrapper hands out "not exist" slots for unknown ids —
    // never write through those). Only ids the rig actually has are
    // cached, so every write through this driver is a guaranteed hit; the
    // core clamps all writes to each parameter's own min/max.
    this._idx = {};
    this._params = new Set(); // ids the rig owns (existence set)
    const core = model.internalModel ? model.internalModel.coreModel : null;
    if (core) {
      const count = core.getParameterCount();
      for (const id of Object.values(P)) {
        const i = core.getParameterIndex(id);
        if (i >= 0 && i < count) {
          this._idx[id] = i;
          this._params.add(id);
        }
      }
      // Extra ids used by poke reactions beyond the P set.
      for (const id of ['ParamEyeLSmile', 'ParamEyeRSmile', 'ParamBrowLAngle', 'ParamBrowRAngle']) {
        if (this._idx[id] !== undefined) continue;
        const i = core.getParameterIndex(id);
        if (i >= 0 && i < count) {
          this._idx[id] = i;
          this._params.add(id);
        }
      }
      // Ambient-drift chains (ambientSway): the orphaned ornament +
      // headpiece ids are written DIRECTLY by the driver each frame
      // (the skirt/hair chains ride the secondary layer's post-physics
      // slot instead). Adopted here so the writes always hit.
      for (const id of [...AMBIENT_CHAINS.ornaments, ...AMBIENT_CHAINS.headpiece]) {
        if (this._idx[id] !== undefined) continue;
        const i = core.getParameterIndex(id);
        if (i >= 0 && i < count) {
          this._idx[id] = i;
          this._params.add(id);
        }
      }
    }

    /** Framework auto-behaviors that would fight this driver, disabled —
     * this driver owns them, and layers its parameters ADDITIVELY on top
     * of whatever the framework's own pipeline produces:
     * - CubismEyeBlink: the rig's own blink writes absolute lid values on
     *   the same params as our blink (they would fight every frame).
     * - CubismBreath ("natural movements"): adds its own sway to
     *   ParamAngleX/Y/Z, ParamBodyAngleX and ParamBreath (same channels as
     *   our signs-of-life — doubled sways look wrong).
     * Idle MOTIONS are LEFT ENABLED: the framework auto-plays a random
     * motion from the idle group when none is playing, and motions are
     * what models with authored animations (sways, waves, blinks built
     * into motion files) actually use.
     * PARAMETER LAYERING: the driver cannot write before model.update()
     * (motions would clobber its values) nor in beforeModelUpdate (that
     * fires after physics and its values are discarded by the pipeline's
     * trailing loadParameters() restore). The correct spot — the same one
     * the framework's own expressions use — is after saveParameters()
     * and BEFORE physics.evaluate, so the combined values feed both the
     * physics chains (hair/cloth sway reacts to gaze+motion) and the draw.
     * There is no event there, so the driver wraps physics.evaluate.
     * The internal update pipeline null-checks eyeBlink/breath. */
    const im = model.internalModel;
    if (im) {
      if (im.eyeBlink) im.eyeBlink = null;
      if (im.breath) im.breath = null;
      this.secondary = null; // attached by the renderer (setSecondary)
      this._patchPipeline(im);
    }

    /** Eyes' SCREEN position (window px), fed by the renderer after each
     * fit (see setEyeScreen). Resting gaze spots center on it so the head
     * rests level. Defaults to a sensible spot until the first fit. */
    this.eyePx = { x: window.innerWidth / 2, y: window.innerHeight * 0.42 };

    /** Clamped gaze direction of the current frame (eyeX ∈ [-1, 1] units,
     * pitch in deg; yaw+ = her left, pitch+ = up), computed while aiming. */
    this.lookYaw = 0;
    this.lookPitch = 0;

    /** The facial action currently playing, if any. Random scheduled
     * actions were removed by request — only poke reactions use this. */
    this.action = null;

    /** Whole-body pose channel — likewise only fed by poke reactions. */
    this.bodyAction = null;
    /** Whole-body horizontal rig nudge (px, + right), fed by the choreo
     * rigDx channel; applied by the render loop beside poseDy. */
    this.poseDx = 0;
    /** The authored-animation engine (set by the renderer per attach). */
    this.choreo = null;

    // Poke snap guard: when a poke replaces an action mid-flight, the
    // interrupted action is kept here and its contributions decay over
    // POKE_FADE_MS while the reaction crossfades in (see applyFrame).
    this.fadingFace = null; // { action, t0 }
    this.fadingBody = null; // { action, t0 }

    this.blink = {
      phase: 'open',
      nextAt: performance.now() + 1200 + Math.random() * 2000,
      t0: 0,
      /** Normalized 0..1 lid openness computed for the current frame. */
      open: 1,
    };

    /** Whether the gaze follows the cursor (see setTrackMouse). */
    this.trackMouse = true;

    /** Cursor tracking, viewer-parity: normalized [-1,1] target smoothed
     * toward the pointer (window-center origin) ~0.15/frame. The raw target
     * itself is a local inside updateCursorTracking (see there). */
    this.mouse = { x: 0, y: 0 };

    this.pointer = { x: window.innerWidth / 2, y: window.innerHeight * 0.5, at: 0 };
    // Resting gaze spot used while wandering; retargeted every so often so
    // the eyes make natural saccade hops instead of drifting continuously.
    this.wander = { x: window.innerWidth / 2, y: window.innerHeight * 0.5, nextAt: 0 };
    // Last computed gaze target (window-relative px); actions may offset it.
    // (The blended cursor/wander target itself is derived in
    // updateCursorTracking from this.pointer + this.wander + followAmt.)
    /** Scale applied to the tracking gains this frame (glances/wander run
     * gentler than actual cursor tracking). */
    this.gazeScale = 1;
    /** Smooth cursor engagement (0..1): how much the gaze currently favors
     * the live cursor over the resting/wander spot. Ramps via
     * FOLLOW_ENGAGE_RATE in updateCursorTracking so the follow <-> wander
     * hand-off is a gradual ease, never an instant head snap. */
    this.followAmt = 0;

    // Damped head-follow state (degrees; yaw+ = her left, pitch+ = up).
    // Pitch starts level.
    this.headYaw = 0;
    this.headPitch = NEUTRAL_HEAD_PITCH;

    /** Motion blend: eases toward 1 while the framework's own motion is
     * playing (authored animation), 0 otherwise. Driver channels that a
     * motion would fight (head/body/breath sway) are scaled by
     * (1 - motionBlend) so the authored animation reads at full strength
     * and the driver only adds what's left — gaze stays live at a reduced
     * weight so she still follows the cursor mid-motion, and the blink is
     * always applied (a blink over a motion's own lids is just a blink). */
    this.motionBlend = 0;

    /** Tail idle hold (per-model "tailIdle" in choreo-config.json,
     * default 0 = tail hidden at rest). When >0 the procedural layer
     * holds Param59 at that value plus a slow sine sway; an authored
     * tail choreo still overrides on top (its lerp absorbs this add). */
    this.tailIdle = 0;
    /** Randomized tail sway period (5-8 s per the config contract). */
    this._tailSwayPeriod = 6.5;
    this._loadTailIdle();

    console.log(
      `[vtuber] idle driver ready (params: ${Object.keys(this._idx).length}; ` +
        `standard set: ${
          Object.keys(P)
            .filter((k) => this.has(P[k]))
            .join(', ') || 'none'
        })`,
    );
  }

  /* ------------------------------------------------------- param write --- */

  has(id) {
    return this._idx[id] !== undefined;
  }

  /** Add `amount` to bucket[id] (creating it). */
  static add(bucket, id, amount) {
    bucket[id] = (bucket[id] || 0) + amount;
  }

  /* ------------------------------------------------------------- choreo ---
   * The authored-animation engine (choreo.js) is attached here by the
   * renderer after each model load; it samples in applyFrame and its
   * Map is applied inside _applyPendingParams AFTER the adds — the
   * lerp blend overrides cursor/procedural writes on the same ids
   * naturally (weight 1 = full override). */
  setChoreo(engine) {
    this.choreo = engine;
    this._choreoSample = null;
  }

  /** Attach the secondary-language layer (secondary.js). It is driven
   * from THIS driver's frame discipline: sample(dt) advances its clock
   * here in applyFrame, its continuous offsets are fed from the
   * expression secondary table below, and the pipeline wrapper applies
   * its writes AFTER physics.evaluate (the wrapper's secondary half
   * calls layer.apply()). Re-pointed per attach like the choreo engine.
   * The AMBIENT direct-write id list (ornaments + headpiece, orphaned
   * chains) is rebuilt here from the rig's existence set. */
  setSecondary(layer) {
    this.secondary = layer;
    this._ambientIds = layer
      ? [...layer.ambientOrnamentIds(), ...layer.ambientHeadpieceIds()].filter((id) =>
          this._params.has(id),
        )
      : [];
  }

  /* ---------------------------------------------- secondary offsets ---
   * Expression body-language: compute this frame's continuous
   * secondary-chain offsets from EXPRESSION_SECONDARY, scaled by the
   * ACTIVE expression's LIVE queue fade weight (0.4 s crossfade — the
   * same value the SDK blends the face parameters with, read from the
   * queue entries' getStateWeight()), so ears rise/droop WITH the face.
   * Pulsed extras (embarrassed's fidget re-fire, love's alternating
   * flicks) fire through the layer's pulse API on their own cadences
   * while their expression holds. */
  updateSecondaryOffsets(now) {
    const em = this.model.internalModel?.motionManager?.expressionManager;
    const layer = this.secondary;
    if (!em || !layer || layer.destroyed) {
      this._secondaryOffsets = { earL: 0, earR: 0, splay: 0, hair: 0, skirt: 0 };
      return;
    }

    // Live weight per expression NAME: the queue can hold several
    // entries mid-crossfade; sum their contributions (a fading-out
    // face's ears relax while the new face's rise — additive reads
    // naturally).
    const weights = new Map(); // definition Name -> weight
    const queue = em.queueManager?._motions ?? [];
    for (const entry of queue) {
      const motion = entry?._motion;
      if (!motion || entry.isFinished?.()) continue;
      const w = entry.getStateWeight?.() ?? 0;
      if (!w) continue;
      const idx = em.expressions.indexOf(motion);
      const name =
        motion === em.defaultExpression ? 'normal' : idx >= 0 ? em.definitions[idx]?.Name : null;
      if (!name) continue;
      weights.set(name, (weights.get(name) ?? 0) + w);
    }

    const out = { earL: 0, earR: 0, splay: 0, hair: 0, skirt: 0 };
    for (const [name, w] of weights) {
      const cfg = EXPRESSION_SECONDARY[name];
      if (!cfg) continue;
      const k = Math.min(1, w); // clamp over-sums (never exceeds ~1 in practice)
      if (cfg.droop) {
        out.earL += cfg.droop * k;
        out.earR += cfg.droop * k;
      }
      if (cfg.prick) {
        // prick = opposite of droop; oneEar limits it to one side.
        if (cfg.oneEar === 'L' || !cfg.oneEar) out.earL -= cfg.prick * k;
        if (cfg.oneEar === 'R' || !cfg.oneEar) out.earR -= cfg.prick * k;
      }
      if (cfg.splay) out.splay += cfg.splay * k;
      if (cfg.wave) {
        // Slow ear "weaving": a gentle sine per ear (period ~0.8 Hz) with the
        // right ear phase-shifted, so the two ears undulate softly like an
        // anime character's instead of vibrating. now is milliseconds.
        const wAmp = cfg.wave.amp || 0;
        const wPer = cfg.wave.period || 1300; // ms per cycle
        const ph = cfg.wave.phase || 0;
        out.earL += wAmp * Math.sin((now / wPer) * 2 * Math.PI) * k;
        out.earR += wAmp * Math.sin((now / wPer) * 2 * Math.PI + ph) * k;
      }
    }
    this._secondaryOffsets = out;

    // Pulsed extras while their expression holds (weight-gated).
    this._updateSecondaryPulses(now, weights);
  }

  /** Per-expression pulse cadences. State survives across frames on
   * this driver instance (cadence timers in ms). Amplitudes/cycles come
   * from the EXPRESSION_SECONDARY entries (fidget/flick) so the config
   * table stays the single source of truth. */
  _updateSecondaryPulses(now, weights) {
    const layer = this.secondary;
    if (!layer || layer.destroyed) return;
    const wOf = (name) => weights.get(name) ?? 0;

    // embarrassed: skirtFidget refires every 2.4 s while held.
    const fidget = EXPRESSION_SECONDARY.embarrassed?.fidget;
    if (fidget && wOf('embarrassed') >= 0.3) {
      if (!this._secFidgetAt || now - this._secFidgetAt >= 2400) {
        layer.skirtFidget(fidget.amp ?? 3, fidget.cycles ?? 2);
        this._secFidgetAt = now;
      }
    } else {
      this._secFidgetAt = 0;
    }

    // love: alternating per-ear flicks every 0.7-1.3 s while held.
    if (wOf('love') >= 0.3) {
      if (!this._secFlickAt) this._secFlickAt = now;
      const gap = this._secFlickGap ?? 1000;
      if (now - this._secFlickAt >= gap) {
        this._secFlickEar ??= 'R';
        this._secFlickEar = this._secFlickEar === 'L' ? 'R' : 'L';
        layer.earFlick(this._secFlickEar, 5, 0.4);
        this._secFlickAt = now;
        // next gap: random in the 0.7-1.3 s band
        this._secFlickGap = 700 + Math.random() * 600;
      }
    } else {
      this._secFlickAt = 0;
      this._secFlickEar = null;
      this._secFlickGap = null;
    }
  }

  /* -------------------------------------------------------------- blink --- */

  updateBlink(now) {
    const b = this.blink;
    // `open` is a normalized 0..1 lid openness for THIS frame. The state
    // machine always runs a blink to completion (closing → hold → opening) —
    // nothing resets it mid-way, so a blink can never be cut short.
    switch (b.phase) {
      case 'open':
        b.open = 1;
        if (now >= b.nextAt) {
          b.phase = 'closing';
          b.t0 = now;
        }
        break;
      case 'closing': {
        const p = clamp01((now - b.t0) / BLINK_CLOSE_MS);
        b.open = 1 - easeInQuad(p);
        if (p >= 1) {
          b.phase = 'hold';
          b.t0 = now;
        }
        break;
      }
      case 'hold':
        b.open = 0;
        if (now - b.t0 >= BLINK_HOLD_MS) {
          b.phase = 'opening';
          b.t0 = now;
        }
        break;
      case 'opening': {
        const p = clamp01((now - b.t0) / BLINK_OPEN_MS);
        b.open = smoothstep(0, 1, p);
        if (p >= 1) {
          b.phase = 'open';
          // Natural, slightly irregular blink cadence — frequent enough
          // that she never looks like she stopped blinking. Roughly 1 in 8
          // blinks is a quick double.
          const gap = 1800 + Math.random() * 3200;
          b.nextAt = now + (Math.random() < 0.12 ? 220 + Math.random() * 260 : gap);
        }
        break;
      }
    }

    b.closed = 1 - b.open;
    return b.closed;
  }

  /**
   * Apply the blink as the FINAL, authoritative word on the lids — called
   * inside the pipeline wrapper, after every motion/expression/driver write
   * has landed. Both eyes are always driven from the one shared `closed`
   * number so they can never desync. The write is multiplicative on the
   * parameter's CURRENT value (a motion's own eye-open animation survives
   * underneath and the lids close over it).
   * `extraClosed` folds in squints (smile eyes close a little, the idle
   * flourish closes fully).
   */
  applyBlinkTo(extraClosed = 0) {
    const closed = Math.min(1, (this.blink.closed || 0) + extraClosed);
    if (closed <= 0.001) return;
    const core = this.model.internalModel.coreModel;
    const keep = 1 - closed;
    const li = this._idx[P.eyeLOpen];
    if (li !== undefined) {
      core.setParameterValueByIndex(li, core.getParameterValueByIndex(li) * keep);
    }
    const ri = this._idx[P.eyeROpen];
    if (ri !== undefined) {
      core.setParameterValueByIndex(ri, core.getParameterValueByIndex(ri) * keep);
    }
  }

  /* --------------------------------------------------------------- gaze --- */

  /** Enables/disables cursor tracking. While disabled the pointer is neither
   * captured nor followed — she just wanders around on her own.
   * `hardPark`: additionally FREEZES the gaze
   * wander so the eyes sit dead-center — so expression eyeBall signatures
   * read the expression alone (wander hops otherwise land on the same
   * ids). */
  setTrackMouse(enabled, hardPark = false) {
    if (hardPark) {
      // neutral gaze immediately: no wander hops, no cursor
      this.trackMouse = false;
      this.wander.x = window.innerWidth / 2;
      this.wander.y = window.innerHeight / 2;
      this.wander.nextAt = Infinity;
      this.pointer.at = 0;
      return;
    }
    if (this.trackMouse === enabled) return;
    this.trackMouse = enabled;
    if (!enabled) {
      this.pointer.at = 0; // invalidate the last cursor position right away
      this.wander.nextAt = 0; // pick a fresh wander spot on the next frame
    }
  }

  /** Feed a gaze target (window-relative coords): in-window positions come
   * from the renderer's own mousemove (zero latency), out-window ones from
   * the main-process cursor stream — together the eyes follow the pointer
   * everywhere on screen. */
  setPointer(x, y) {
    if (!this.trackMouse) return;
    this.pointer.x = x;
    this.pointer.y = y;
    this.pointer.at = performance.now();
  }

  /** Eyes' SCREEN position (window px) — kept for gaze-spot anchoring. */
  setEyeScreen(px, py) {
    this.eyePx.x = px;
    this.eyePx.y = py;
  }

  /**
   * Cursor tracking: normalize the gaze target to [-1, 1] around the WINDOW
   * center and exponentially smooth toward it each frame (rate-based so it
   * holds at any refresh). The key change from a hard on/off: this.followAmt
   * ramps smoothly between "following the live cursor" and "resting on the
   * wander spot", so the moment the cursor stops moving (or resumes) the head
   * eases across the boundary instead of turning instantly.
   */
  updateCursorTracking(delta, now) {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // The pointer is "fresh" while it keeps being updated (cursor moving or
    // recently stopped within WANDER_AFTER_MS). We treat that as a DESIRED
    // engagement and ease this.followAmt toward it — no discrete jump.
    const pointerFresh = this.pointer.at > 0 && now - this.pointer.at < WANDER_AFTER_MS;
    const want = this.trackMouse && pointerFresh;
    const ek = 1 - Math.exp(-FOLLOW_ENGAGE_RATE * delta);
    this.followAmt += ((want ? 1 : 0) - this.followAmt) * ek;
    if (this.followAmt < 0.001) this.followAmt = 0;
    else if (this.followAmt > 0.999) this.followAmt = 1;

    // NOTE: the former "steal a glance away from the cursor" behavior is
    // REMOVED — it fired every ~9-19 s and made her briefly look away from a
    // cursor the user was actively moving, which read as an unpredictable
    // "auto-unfollow." The gaze now always follows the cursor while engaged
    // (the grace comes from the followAmt blend below, not random glances).

    // Wander spot: hop between resting places (saccade-style) at rest.
    if (now >= this.wander.nextAt) {
      this.wander.x = w * (0.2 + Math.random() * 0.6);
      this.wander.y = clampGazeSpotY(this.eyePx.y + h * (-0.06 + Math.random() * 0.12), h);
      this.wander.nextAt = now + 1900 + Math.random() * 3200;
    }

    // Normalize a window-relative point to [-1, 1] (center = 0,0; +1 =
    // right/top). Y is FLIPPED (screen y+ down; ParamAngleY+ is up).
    const normX = (px) => clamp((px / w) * 2 - 1, -1, 1);
    const normY = (py) => clamp(1 - (py / h) * 2, -1, 1);

    let rawX;
    let rawY;
    let scale;
    {
      // BLEND between the live cursor and the resting spot by followAmt —
      // this is what makes follow-in and follow-out gradual instead of a
      // snap: as followAmt eases 0 -> 1 the target glides from the wander
      // spot onto the cursor (and back on the way out).
      const f = this.followAmt;
      rawX = normX(this.pointer.x) * f + normX(this.wander.x) * (1 - f);
      rawY = normY(this.pointer.y) * f + normY(this.wander.y) * (1 - f);
      // Gain scale blends too: rest reads calm (0.35), live cursor reads
      // full (1) — no scale discontinuity at the boundary.
      scale = GAZE_WANDER_SCALE + (1 - GAZE_WANDER_SCALE) * f;
    }

    // Exponential smoothing toward the blended target (the sample's
    // `current += (target-current)*0.15` at 60fps, as a rate).
    const k = 1 - Math.exp(-MOUSE_SMOOTH_RATE * delta);
    this.mouse.x += (rawX - this.mouse.x) * k;
    this.mouse.y += (rawY - this.mouse.y) * k;

    this.gazeScale = scale;
  }

  /**
   * Damped head follow: the smoothed cursor drives head yaw/pitch with the
   * viewer gains; the head eases behind the eyes with a light extra lag
   * (the viewer's eased feel — eyes lead, head settles).
   */
  updateHeadFollow(delta) {
    const s = this.gazeScale || 1;
    const targetYaw = clamp(
      this.mouse.x * HEAD_YAW_GAIN * s,
      -HEAD_YAW_HARD_MAX,
      HEAD_YAW_HARD_MAX,
    );
    const targetPitch = clamp(
      this.mouse.y * HEAD_PITCH_GAIN * s,
      HEAD_PITCH_HARD_MIN,
      HEAD_PITCH_HARD_MAX,
    );
    const k = 1 - Math.exp(-HEAD_FOLLOW_RATE * delta);
    // Rate-limited follow: the exponential eases the tail in/out, and the
    // HEAD_TURN_RATE cap bounds the peak angular velocity so a large target
    // jump glides instead of snapping (see the constant's comment). Without
    // the cap, proportional easing covers a full swing too fast to read as
    // a gentle head turn.
    const maxStep = HEAD_TURN_RATE * delta;
    let dy = (targetYaw - this.headYaw) * k;
    let dp = (targetPitch - this.headPitch) * k;
    dy = clamp(dy, -maxStep, maxStep);
    dp = clamp(dp, -maxStep, maxStep);
    this.headYaw += dy;
    this.headPitch += dp;
    // Eyes follow the smoothed mouse directly (sample gain 1).
    this.lookYaw = clamp(this.mouse.x * s, -1, 1);
    this.lookPitch = clamp(this.mouse.y * s, -1, 1);
  }

  /* ------------------------------------------------------ idle actions --- */

  /** Smooth 0 -> 1 -> 0 envelope so actions ease in and out. Squared sine
   * gives zero velocity at both ends — movements start and settle like
   * butter instead of snapping in and out. */
  bump(t) {
    const s = Math.sin(Math.PI * t);
    return s * s;
  }

  /**
   * Facial action lifecycle: random scheduled actions were removed by
   * request, so this channel only ever carries poke reactions — it merely
   * retires an action once its duration has elapsed.
   */
  updateAction(now) {
    if (!this.action) return;
    if ((now - this.action.t0) / this.action.duration >= 1) this.action = null;
  }

  /**
   * Whole-body action lifecycle: same story — the poke reaction (hop) is
   * the only source, so this only retires a finished action.
   */
  updateBodyAction(now) {
    if (!this.bodyAction) return;
    if ((now - this.bodyAction.t0) / this.bodyAction.duration >= 1) {
      this.bodyAction = null;
    }
  }

  /** One quick, light two-footed bounce — kept ONLY as a poke reaction
   * (jumps/bounces are otherwise disabled by request). In Live2D the whole
   * model moves up/down (the rig's position.y), so this is a body-rise
   * action. */
  makeHop() {
    const height = 14 + Math.random() * 8; // screen px
    return {
      duration: 850 + Math.random() * 300,
      blocksFace: true,
      apply: (t, pose) => {
        const tLaunch = 0.14; // little dip ends, pop begins
        const tLand = 0.58; // touchdown
        if (t < tLaunch) {
          const p = smoothstep(0, 1, t / tLaunch);
          pose.dy -= 8 * p;
        } else if (t < tLand) {
          const s = (t - tLaunch) / (tLand - tLaunch);
          const arc = 4 * s * (1 - s);
          const dip = 1 - smoothstep(0, 0.3, s);
          pose.dy += height * arc - 8 * dip;
        } else {
          const p = 1 - smoothstep(0, 1, (t - tLand) / (1 - tLand));
          pose.dy -= 8 * p;
        }
      },
    };
  }

  /* ------------------------------------------------------- poke reaction --- */

  /**
   * Double-tap on the character/container: a bigger reaction than a poke —
   * a playful full-body shake, as if she is delighted you noticed her.
   * BODY-ONLY by design: no face writes, no icon, no expression change
   * (the face belongs to the expression system; procedural face writes
   * were the stuck-half-lidded-eyes bug).
   */
  dblGiggle() {
    const now = performance.now();
    const reaction = () => ({
      duration: 1500 + Math.random() * 500,
      apply: (t, frame) => {
        const g = this.bump(t);
        // playful rapid shake: head roll + body roll at ~6 Hz, decaying
        frame.headRoll = (frame.headRoll || 0) + 10 * Math.sin(12 * Math.PI * t) * g;
        frame.bodyRoll = (frame.bodyRoll || 0) + 6 * Math.sin(10 * Math.PI * t) * g;
        frame.headPitch = (frame.headPitch || 0) - 2 * g;
      },
    });
    // crossfade out whatever was playing (same snap guard as poke())
    if (this.action) this.fadingFace = { action: this.action, t0: now };
    this.action = { t0: now, ...reaction() };
  }

  /**
   * React right away to a poke (a click on her): BODY-ONLY quick
   * responses (rock/tilt/hop) — no face writes (see dblGiggle).
   */
  poke() {
    const now = performance.now();
    const reactions = [];

    // Little happy rock.
    reactions.push(() => ({
      duration: 1600 + Math.random() * 600,
      apply: (t, frame) => {
        const g = this.bump(t);
        frame.bodyRoll = 6 * Math.sin(4 * Math.PI * t) * g;
      },
    }));

    // Startled double-take: head recoils a touch (head only — no brows,
    // no eye writes).
    reactions.push(() => ({
      duration: 1300 + Math.random() * 500,
      apply: (t, frame) => {
        const s = this.bump(t);
        frame.headPitch = (frame.headPitch || 0) - 6 * s;
        frame.gazeY = -window.innerHeight * 0.06 * s;
      },
    }));

    // Curious head tilt (body channel — no blink writes: an
    // action-driven blinkAdd holds the lids and reads as a stuck
    // half-lidded face when it collides with expression eye values).
    reactions.push(() => {
      const amp = Math.random() < 0.5 ? -9 : 9;
      return {
        duration: 1700 + Math.random() * 600,
        apply: (t, frame) => {
          frame.headRoll = amp * this.bump(t);
        },
      };
    });

    // Quick little hop.
    reactions.push(() => ({ kind: 'body', action: this.makeHop() }));

    const make = reactions[Math.floor(Math.random() * reactions.length)];
    const picked = make();
    // Snap guard: the interrupted action is not dropped in a single frame —
    // it fades out over POKE_FADE_MS while the reaction crossfades in.
    // The reaction MUST be stamped with t0 — without it the (now - t0)
    // progress math yields NaN, the reaction never renders, and the
    // finished check never fires, which wedges the whole action channel
    // for the rest of the session.
    if (picked.kind === 'body') {
      if (this.bodyAction) this.fadingBody = { action: this.bodyAction, t0: now };
      this.bodyAction = { t0: now, ...picked.action };
    } else {
      if (this.action) this.fadingFace = { action: this.action, t0: now };
      this.action = { t0: now, ...picked };
    }
  }

  /* ------------------------------------------------- pipeline injection --- */

  /**
   * Inject the driver's parameters into the internal update pipeline at
   * the correct slot: AFTER saveParameters()/motions/expressions (so
   * authored animation values are the base the driver adds onto) and
   * BEFORE physics.evaluate (so hair/cloth chains react to the combined
   * values). Done by wrapping the physics object's evaluate — the only
   * seam at that point in the pipeline (no event exists there).
   *
   * Frame discipline: applyFrame() composes a fresh parameter set every
   * frame and parks it in _pendingParams; the pipeline wrapper applies
   * whatever is parked (additive + blink) and clears it. Exactly one
   * application per pipeline run; a superseded composition (model switched
   * mid-frame) simply never applies.
   */
  _patchPipeline(im) {
    this._pendingParams = null;
    const physics = im.physics;
    if (physics) {
      // One permanent wrapper per physics object, re-pointed at the
      // CURRENT driver on every attach: the internal model (and its
      // physics) persists in the model cache across switches while
      // IdleDriver instances are recreated per attach, so a wrapper bound
      // to one driver instance would go stale the moment the model is
      // detached and re-attached.
      // The wrapper is installed ONCE for the physics object's lifetime
      // (guarded by the permanent __driverWrapped flag) and only the
      // dispatch pointer is re-pointed on each attach. destroy() clears
      // the pointer but NEVER the wrapped flag, so a re-attached model
      // reuses the single wrapper instead of wrapping it again — an
      // onion of wrappers would otherwise double-apply the secondary
      // layer every frame after the first switch.
      if (!physics.__driverWrapped) {
        physics.__driverWrapped = true;
        const origEvaluate = physics.evaluate.bind(physics);
        physics.evaluate = (model, dt) => {
          const d = physics.__driverDispatch;
          if (d) d._applyPendingParams();
          origEvaluate(model, dt);
          // SECONDARY LAYER SLOT (post-physics): the sole sanctioned
          // additive writer for the physics-owned ear/hair/skirt chains.
          // After physics.evaluate (its output is the base) and before
          // pose/model.update (the values reach the draw; the trailing
          // loadParameters() wipes them exactly like every other
          // in-pipeline write).
          if (d?.secondary && !d.secondary.destroyed) d.secondary.apply();
        };
      }
      physics.__driverDispatch = this;
    } else {
      // Model without physics: hook the pipeline's beforeModelUpdate
      // instead (draw-correct; there is no physics to feed anyway).
      // Persistent listener — _applyPendingParams no-ops when nothing
      // is parked. Same single-install/re-point discipline as the
      // physics wrapper (see the __driverWrapped guard above).
      if (!im.__driverWrapped) {
        im.__driverWrapped = true;
        im.on('beforeModelUpdate', () => {
          const d = im.__driverDispatch;
          if (d) d._applyPendingParams();
          // Secondary layer, no-physics fallback: same post-slot
          // discipline (nothing ran before it; the draw still consumes
          // the values before the trailing restore wipes them).
          if (d?.secondary && !d.secondary.destroyed) d.secondary.apply();
        });
      }
      im.__driverDispatch = this;
    }
  }

  /** Detach from the pipeline wrapper so a parked composition from this
   * driver can never apply after its model was switched away. Only the
   * dispatch pointer is cleared — the wrapper itself (and its permanent
   * __driverWrapped marker) is left in place so a re-attached model
   * reuses the single wrapper instead of stacking a new one (see
   * _patchPipeline). */
  destroy() {
    this.choreo = null;
    this.secondary = null;
    const im = this.model.internalModel;
    if (im) {
      if (im.physics && im.physics.__driverDispatch === this) {
        im.physics.__driverDispatch = null;
      }
      if (im.__driverDispatch === this) {
        im.__driverDispatch = null;
      }
    }
    this._pendingParams = null;
  }

  /** Load the per-model tailIdle hold from choreo-config.json (the same
   * file the choreo engine reads for signMap — one config per model).
   * 0 (or missing file) keeps the tail hidden at rest, exactly as
   * before. Re-applied per driver instance, so a model reload picks
   * up config edits. */
  async _loadTailIdle() {
    try {
      const settings = this.model.internalModel?.settings;
      const res = await fetch(settings.resolveURL('choreo-config.json'));
      if (res.ok) {
        const data = await res.json();
        const v = Number(data?.tailIdle);
        if (Number.isFinite(v) && v > 0) {
          this.tailIdle = Math.min(1, v);
          this._tailSwayPeriod = 5 + Math.random() * 3; // 5-8 s
          console.log(
            `[vtuber] tailIdle: holding Param59 at ${this.tailIdle} (+/-0.15 sway, ${this._tailSwayPeriod.toFixed(1)} s period)`,
          );
        }
      }
    } catch {
      /* no config — tail stays at rest, as before */
    }
  }

  /** Apply the parked parameter composition into the core model (called
   * from the physics wrapper each pipeline run). Additive channels use
   * addParameterValueById (an in-flight motion's value survives
   * underneath); the choreo layer lerps ON TOP of the adds (base +
   * (target - base) * weight — weight 1 = full override); the blink is
   * multiplicative on the current lid values, so a motion's own
   * eye-open animation survives and the lids close over it. */
  _applyPendingParams() {
    const pending = this._pendingParams;
    this._pendingParams = null;
    if (!pending) return;
    const core = this.model.internalModel.coreModel;
    for (const [id, amount] of Object.entries(pending.adds)) {
      if (!this._params.has(id)) continue;
      core.addParameterValueById(id, amount, 1);
    }
    // Choreo: applied after the adds — the lerp absorbs the cursor/
    // procedural contributions on choreo-driven ids by construction.
    const sample = pending.choreo;
    if (sample) {
      for (const [id, { target, weight }] of sample) {
        if (id === 'rigDy' || id === 'rigDx') continue; // rig channels
        if (!this._params.has(id)) continue;
        const base = core.getParameterValueById(id);
        core.setParameterValueById(id, base + (target - base) * weight, 1);
      }
    }
    this.applyBlinkTo(pending.blinkAdd);
  }

  /**
   * Track whether the framework's own authored animation is running and
   * ease the blend; while none is playing, occasionally showcase one of
   * the rig's own expressions (if it ships any) — showing the model's
   * faces off and restoring afterwards.
   */
  updateMotionBlend(delta) {
    const mm = this.model.internalModel?.motionManager;
    // The perpetual background "idle" loop (idle-sway) plays forever by
    // design — suppressing the driver's gaze/breath for its entire
    // runtime would kill cursor-follow and breathing (motionBlend is
    // for strong one-shot authored motions). Idle-group playback is
    // therefore additive background: values land underneath, the
    // driver's adds keep full strength, and the core clamps compose.
    const playingGroup = mm?.state?.currentGroup;
    const isIdleGroup = playingGroup === (mm?.groups?.idle ?? 'idle');
    const playing = Boolean(mm && mm.playing) && !isIdleGroup;
    const k = 1 - Math.exp(-(playing ? 4 : 2.5) * delta);
    this.motionBlend += ((playing ? 1 : 0) - this.motionBlend) * k;
    if (this.motionBlend < 0.002 && !playing) this.motionBlend = 0;

    // NOTE: the former "expression showcase" (auto-playing a random
    // face every 25-60 s and resetting it) is REMOVED — it hijacked
    // user-pinned faces (setExpression/panel picks changed or reset
    // seemingly at random). Faces hold until deliberately changed.
  }

  /* -------------------------------------------------------- frame write --- */

  /**
   * Compose everything for this frame. Runs in the renderer's ticker BEFORE
   * model.update(): it computes the frame's parameters but does NOT write
   * them yet — they are parked for the pipeline wrapper, which applies them
   * at the expressions' slot (after motions/saveParameters, before physics)
   * so authored animations are the base, the driver's gaze/breath/blink
   * add on top, and physics chains react to the combination.
   */
  applyFrame(delta) {
    const now = performance.now();

    // Degenerate viewport (minimize/restore race, DPI change): the gaze math
    // divides by the window size and would latch NaN into the damped head
    // state — permanently. Hold the last good pose until the real size is
    // back; this is the same predicate fitModel uses.
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    if (!winW || !winH || winW < 8 || winH < 8) return;

    // Retire any finished (poke-reaction) actions.
    this.updateBodyAction(now);
    this.updateAction(now);

    // Motion blend: track whether the framework's own motion is playing.
    // Authored animations read at full strength; driver idle channels that
    // would fight them fade out, and the model's own expressions get a
    // showcase window while idle.
    this.updateMotionBlend(delta);

    // Whole-body pose bucket: neutral unless a body action is playing.
    // Channels: dy = vertical px offset, bodyX/bodyY/bodyZ = angle params,
    // breath = 0..1 (added onto the rig's own breath param). The driver
    // keeps the signs of life (breath bob, micro sway) — ALL secondary
    // motion (hair/cloth/ears) comes from the model's own physics3.json
    // via the SDK physics, driven by these body/head angles.
    const pose = {
      dy: 0,
      bodyX: 0,
      bodyY: 0,
      bodyZ: 0,
      breath: 0,
    };

    // Always-on signs of life: a soft breathing bob with a hint of chest
    // rise, plus a slow micro sway, so she is never perfectly still. The
    // breath sine runs at the SDK sample's FULL 0..1 amplitude (CubismBreath
    // uses offset 0.5, peak 0.5) — viewer parity, and also the drive that
    // keeps breath-input physics chains (tingyun's waist-ribbon group
    // normalizes ±10) above the SDK's movement threshold so their deep
    // segments stay alive. The sway/breath params are themselves physics
    // inputs, so the authored physics reacts to them.
    // Organic multi-tone breathing + sway: each is a dominant tone plus a
    // second incommensurate low-frequency component (periods in a ~3:2 ratio
    // that never align). A single sine loops visibly and the physics chains
    // it drives (breath -> torso-cloth G2, sway -> hem G0 / hair G1) mirror
    // that flat periodicity; the summed tones read as living motion. The
    // peak amplitude is preserved (0.8+0.2 = 1.0 for breath, so it still
    // normalizes into [0,1] after the 0.5 offset) so the SDK's
    // MovementThreshold stays comfortably exceeded and the physics chains
    // stay alive.
    const breath =
      0.8 * Math.sin(now * ((2 * Math.PI) / 4500)) +
      0.2 * Math.sin(now * ((2 * Math.PI) / 6770) + 1.3);
    const sway =
      0.9 * Math.sin(now * ((2 * Math.PI) / 7300) + 1.7) +
      0.3 * Math.sin(now * ((2 * Math.PI) / 5360) + 0.4);
    pose.dy += 2.2 * breath;
    pose.breath += 0.5 + 0.5 * breath;
    pose.bodyX += 1.1 * sway;
    pose.bodyZ += 0.5 * sway;

    // Facial action bucket (created before the body action runs so big
    // movements can contribute expressions too).
    const frame = {};
    if (this.bodyAction) {
      const t = (now - this.bodyAction.t0) / this.bodyAction.duration;
      if (t < 1) this.bodyAction.apply(t, pose, frame);
    }
    if (this.action) {
      const t = (now - this.action.t0) / this.action.duration;
      if (t < 1) this.action.apply(t, frame);
    }

    // Poke snap guard: an action interrupted by a poke keeps contributing
    // while it decays, crossfaded with the reaction that replaced it.
    if (this.fadingBody) {
      const p = (now - this.fadingBody.t0) / POKE_FADE_MS;
      if (p >= 1) {
        this.fadingBody = null;
      } else {
        const a = this.fadingBody.action;
        const poseOld = {};
        const frameOld = {};
        a.apply(Math.min(1, (now - a.t0) / a.duration), poseOld, frameOld);
        mergeBucket(pose, poseOld, 1 - p);
        mergeBucket(frame, frameOld, 1 - p);
      }
    }
    if (this.fadingFace) {
      const p = (now - this.fadingFace.t0) / POKE_FADE_MS;
      if (p >= 1) {
        this.fadingFace = null;
      } else {
        const a = this.fadingFace.action;
        const frameOld = {};
        a.apply(Math.min(1, (now - a.t0) / a.duration), frameOld);
        mergeBucket(frame, frameOld, 1 - p);
      }
    }

    // --- choreo: advance the authored-animation engine's clock and
    // sample its track (Map<id, {target, weight}>). All timing comes
    // from THIS dt (the ticker's, already clamped upstream) — the
    // engine has no timers of its own. */
    const choreoSample = this.choreo ? this.choreo.sample(delta) : null;

    // --- gaze: viewer-parity cursor tracking — normalize the target to
    // [-1,1] around the window center, smooth it (0.15/frame @60fps), then
    // let the head follow with the sample's gains (actions may offset the
    // gaze — glances, shy looks — through frame.gazeY).
    this.updateCursorTracking(delta, now);
    this.updateHeadFollow(delta);
    // Startled double-take: the reaction's gazeY (window px, + = down on
    // screen) shifts the EYE look vertically so the recoil reads in the
    // eyes too, alongside the head pitch-up from frame.headPitch. It MUST
    // apply here, after updateHeadFollow (which derives lookPitch from the
    // already-smoothed mouse.y). px -> normalized pitch: a change of Δ px
    // in target y = Δ * -2 / h in lookPitch (+ = up).
    const gazeShift = frame.gazeY || 0;
    if (gazeShift) {
      this.lookPitch = clamp(this.lookPitch + (-2 * gazeShift) / window.innerHeight, -1, 1);
    }

    // --- compose the parameter bucket: everything accumulates ADDITIVELY
    // onto the rig's defaults, then is written once, so channels blend
    // instead of clobbering each other. Channels an authored motion is
    // also driving are scaled by (1 - motionBlend) so the model's own
    // animation reads at full strength and the driver only fills what's
    // left. Gaze and blink stay authoritative.
    const mb = this.motionBlend;
    const own = 1 - mb; // driver's weight on motion-owned channels
    const bucket = {};
    // Head: damped gaze follow + action offsets, split across the head and
    // body so turns feel articulated. Hard clamps guarantee the composed
    // pose can never lock upward (or bow) no matter which action layers are
    // playing. Two slow incommensurate micro drifts keep the head from ever
    // freezing between actions — perfect stillness is the one thing that
    // reads as a mannequin.
    const microYaw = 0.5 * Math.sin(now * ((2 * Math.PI) / 9700) + 0.5);
    const microPitch = 0.4 * Math.sin(now * ((2 * Math.PI) / 11300) + 2.1);
    const microRoll = 0.25 * Math.sin(now * ((2 * Math.PI) / 8900) + 1.1);
    const yaw = clamp(
      (this.headYaw + (frame.headYaw || 0)) * own + microYaw,
      -HEAD_YAW_HARD_MAX,
      HEAD_YAW_HARD_MAX,
    );
    const pitch = clamp(
      (this.headPitch + (frame.headPitch || 0)) * own + microPitch,
      HEAD_PITCH_HARD_MIN,
      HEAD_PITCH_HARD_MAX,
    );
    const roll = ((frame.headRoll || 0) + microRoll) * own;
    // Head angles (viewer gains 30/30, damped), eyes at the sample's gain
    // of 1 on the smoothed mouse.
    if (this.has(P.headX)) IdleDriver.add(bucket, P.headX, yaw);
    if (this.has(P.headY)) IdleDriver.add(bucket, P.headY, pitch);
    if (this.has(P.headZ)) IdleDriver.add(bucket, P.headZ, roll);
    const eyeW = Math.max(0.25, own);
    if (this.has(P.eyeX)) IdleDriver.add(bucket, P.eyeX, this.lookYaw * eyeW);
    if (this.has(P.eyeY)) IdleDriver.add(bucket, P.eyeY, this.lookPitch * eyeW);

    // Body channels: torso lean follows the cursor at the sample's gain
    // (mouseX * 10) on top of the idle sway lean.
    const bodyLeanX = this.mouse.x * (this.gazeScale || 1) * BODY_YAW_GAIN;
    if (this.has(P.bodyX)) {
      IdleDriver.add(bucket, P.bodyX, clamp(pose.bodyX + bodyLeanX, -10, 10) * own);
    }
    if (this.has(P.bodyY)) IdleDriver.add(bucket, P.bodyY, clamp(pose.bodyY, -10, 10) * own);
    // Body roll (ParamBodyAngleZ): the idle sway lean (pose.bodyZ) plus the
    // poke "happy rock" / double-take playfulness (frame.bodyRoll) — without
    // this add, those body reactions wrote frame.bodyRoll into nowhere and
    // the whole reaction channel never moved the torso.
    if (this.has(P.bodyZ)) {
      IdleDriver.add(bucket, P.bodyZ, clamp(pose.bodyZ + (frame.bodyRoll || 0), -10, 10) * own);
    }
    if (this.has(P.breath)) IdleDriver.add(bucket, P.breath, clamp01(pose.breath) * own);

    // Tail idle hold (per-model config): Param59 held at tailIdle plus a
    // slow sine sway. Purely additive — an authored tail choreo's lerp
    // overrides it while active (weight 1 absorbs this add). Param59 is
    // NOT physics-owned (verified at load) and never in the expression
    // suppression set, so it simply rides the adds bucket.
    if (this.tailIdle > 0 && this.has(P.tail)) {
      const sway = 0.15 * Math.sin((now / 1000) * ((2 * Math.PI) / this._tailSwayPeriod));
      IdleDriver.add(bucket, P.tail, this.tailIdle + sway);
    }

    // Facial reaction params — POKE reactions are BODY-ONLY by design
    // (no face writes, no icon, no expression change); anything the
    // reaction channel still writes is suppressed here for ids the
    // active expression owns (priority: choreo > expression > procedural).
    this.updateBlink(now);

    // --- park the composed parameters for the pipeline wrapper: applied
    // inside the internal update pipeline at the expressions' slot (after
    // motions/saveParameters, before physics — see _patchPipeline), so
    // authored animations are the base, the driver's gaze/breath/blink
    // add on top, and physics chains react to the combination.
    // --- secondary layer: advance its clock with THIS frame's dt and
    // feed it the expression secondary offsets (already crossfaded by
    // the expression queue weight inside updateSecondaryOffsets). The
    // layer's WRITES happen later — inside the pipeline wrapper's
    // post-physics slot — so like _pendingParams this only composes.
    if (this.secondary && !this.secondary.destroyed) {
      this.updateSecondaryOffsets(now);
      this.secondary.setOffsets(this._secondaryOffsets);
      this.secondary.sample(delta);
      // Ambient channel, direct-write half: the ORPHANED ornament +
      // headpiece chains (nothing else drives them) drift through the
      // driver's own additive bucket — pre-physics, but these ids are
      // not physics inputs, so the drift reaches the draw unchanged.
      // The skirt/hair chains ride the secondary layer's post-physics
      // slot (apply()) instead. Disabled = zero contribution (the
      // exact previous still-cloth idle).
      const amb = this.secondary.ambient;
      if (amb?.enabled) {
        for (const id of this._ambientIds) {
          const v = amb.valueFor(id);
          if (v) IdleDriver.add(bucket, id, v);
        }
      }
    }

    this._pendingParams = {
      adds: bucket,
      choreo: choreoSample && choreoSample.size ? choreoSample : null,
      blinkAdd: frame.blinkAdd || 0,
    };

    // --- whole-body vertical offset (the hop's rise/dip), pivoting the
    // whole rig around the fit's feet anchor. The position itself is owned
    // by the renderer (fitModel + the render loop apply this offset from
    // the anchor every frame), so nothing accumulates and the offset can
    // never desync from the fit clamps. The choreo rigDy hop channel
    // rides the same path (added, not owned); rigDx is the horizontal
    // twin (+ right), applied by the render loop from the same anchor.
    this.poseDy =
      pose.dy +
      (choreoSample?.get('rigDy')?.target || 0) * (choreoSample?.get('rigDy')?.weight ?? 0);
    this.poseDx =
      (choreoSample?.get('rigDx')?.target || 0) * (choreoSample?.get('rigDx')?.weight ?? 0);
  }
}
