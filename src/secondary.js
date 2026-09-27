/**
 * Secondary-language layer: the SOLE sanctioned post-physics additive
 * writer for the rig's physics-owned secondary chains (ears, ear splay,
 * hair, skirt). Everything else in the codebase may only READ these ids.
 *
 * WHY THIS EXISTS: the official viewer's slider probing showed these
 * chains carry strong, expressive motion (per-ear 3-segment bend, ear
 * splay, hair flow, hem swing) — but the physics-ownership guard refuses
 * direct choreo/exp3 authoring on them because SDK physics drives them
 * every frame. The secondary layer reconciles both: it writes ADDITIVELY
 * AFTER physics.evaluate (physics remains the base) and BEFORE
 * pose/model.update (the values reach the draw; the pipeline's trailing
 * loadParameters() wipes them right after — the same discipline as the
 * idle driver's pre-physics slot). Writes are clamped to ±30 per id.
 *
 * PIPELINE SLOT (idle.js _patchPipeline wrapper, post-physics half):
 *   motions → expressions → [driver adds] → physics.evaluate
 *   → [SECONDARY LAYER — this module] → pose → model.update → draw
 *
 * WHIP/FOLLOW-THROUGH SEMANTICS: a pulse aimed at a chain delivers the
 * curve to segment i at (t - i*0.08 s) with amplitude × 0.7^i — the base
 * leads and each following segment trails a little later and softer,
 * which reads as a natural whip cracking down the chain (or, reversed
 * sign per segment, a smooth curved droop/prick wave).
 *
 * CHAIN TABLE (this rig — tingyun, from model-dump.json + physics3.json):
 *   earL   Param4(左1) → Param36(左2) → Param37(左3)      bend chain, base→tip
 *   earR   Param38(右1) → Param39(右2) → Param40(右3)      bend chain, base→tip
 *   splay  Param3(兽耳z物理)                              bilateral V-fan
 *   hair   Param5(头发x1) → Param6(头发x2) → Param7(头发x3) lateral flow chain
 *   skirtX Param25(服装x1) → Param26(服装x2) → Param27(服装x3) hem lateral chain
 *   skirtY Param28(服装y1) → Param29(服装y2) → Param47(服装y3) hem swing chain
 * (Param54/55 are physics INTERMEDIATE nodes — never written here.)
 *
 * HELPERS (all amounts in param units, ±30 clamp, signs from the
 * pixel auto-calibration persisted in choreo-config.json):
 *   earDroop(amount, perEar?) — both (or one) ear chains curve down
 *   earPrick(amount)          — ears rise/stiffen
 *   earFlick(ear, amp, dur)   — one quick flick (whip semantics)
 *   earSplay(amount)          — V-fan wide/narrow
 *   hairWhip(amp, dir)        — hair chain whip in direction dir(±1)
 *   skirtWhip(amp, dir)       — hem chain whip in direction dir(±1)
 *   skirtFidget(amp, cycles)  — rapid nervous hem flutter
 *
 * SOURCES that feed the layer each frame (all additive on top of physics):
 *   - EXPRESSION secondary offsets (continuous, crossfaded 0.4 s with
 *     the expression queue weight — see EXPRESSION_SECONDARY in
 *     idle.js; e.g. sad droops the ears 10, love flicks …)
 *   - CHOREO "secondary" event lists on tracks (one-shot pulses at
 *     authored times, e.g. shake-no fires hairWhip(6) at each direction
 *     change) — carried by the choreo engine's track definitions.
 *   - Direct API calls (earFlick from poke reactions / automation).
 *
 * PER-MODEL CONFIG (choreo-config.json beside the model3.json):
 *   secondaryScale { ear:1, hair:1, skirt:1 }   global amplitude per family
 *   secondarySigns { earL:1, earR:1, splay:1, hair:1, skirt:1 }
 *       per-chain sign flip; the pixel auto-calibration probe writes
 *       the measured signs here.
 *   secondaryDelay { perSegment: 0.08 }   whip inter-segment lag (s)
 *   secondaryDecay { perSegment: 0.7 }    whip per-segment amplitude falloff
 * Missing values default to the constants above — a model without the
 * config behaves identically to one with all-1 entries.
 */

/* --------------------------------------------------------------- ambient ---
 * ambientSway: the always-on gentle cloth/hair/ornament drift of the
 * DEFAULT idle (no input, no expression, no choreo) — she never reads
 * as a static statue. This is NOT an air-current simulation of any
 * kind: it writes only EXISTING parameter ids, additively, in two
 * channels:
 *   - post-physics additive through the secondary layer (this file):
 *     skirt x/y chains + hair chain (they are physics-adjacent, so
 *     they ride ON TOP of physics output in the same slot);
 *   - direct idle-driver writes (idle.js): ornaments + headpiece
 *     chains (orphaned ids — nothing else drives them).
 * EXCLUDED by design: chest (Param20-24) + jelly (Param10-13) — they
 * stay static at idle.
 *
 * MOTION RECIPE (per chain, segment index i):
 *   value_i(t) = A_group * scale * ( 0.6*sin(2πt/P1 + phi_i)
 *                                   + 0.4*sin(2πt/P2 + phi2_i) )
 *               + bias(t),  bias(t) = 0.35*A_group*sin(2πt/P3 + phi3)
 *   - P1 per group randomized 5-8 s, per segment ±0.7 s
 *   - P2 = P1 * 2.7 (non-integer ratio — never loops visibly)
 *   - P3 randomized 23-37 s (slow left-right bias drift so the sway
 *     never feels metronomic)
 *   - phi_i = phi_0 − i*lagPhase, lagPhase 0.5-0.8 rad per segment
 *     (base leads, tip trails = travelling cloth wave)
 * Amplitudes (pre-scale): skirt x 3.0, skirt y 1.5, hair 2.0,
 * ornaments 2.5, headpiece 1.2. Final sums clamp to ±30.
 * Phases randomized per model load; 2 s fade-in after attach (no pop).
 *
 * Runs UNDERNEATH everything (expressions, choreo, cursor, sec-
 * events): amplitudes are small enough to compose with choreo whips
 * without mud — a whip pulse peaks at 8-16 units against an ambient
 * drift of <= 3, so the whip reads and the drift resumes underneath.
 * All channels are pure functions of t: no state, no feedback, no
 * air-current input, nothing dynamic.
 *
 * CONFIG (choreo-config.json):
 *   "ambientSway": { "enabled": true, "scale": 1.0,
 *     "groups": { "skirt": 1, "hair": 1, "ornaments": 1, "headpiece": 1 } }
 * enabled=false must restore the previous still-cloth idle exactly —
 * the A/B switch: every channel returns 0 and the direct-write path
 * (idle.js) skips the ids entirely.
 */

/** Ambient channel id groups (existing ids only — nothing invented). */
export const AMBIENT_CHAINS = {
  // post-physics additive (secondary-layer slot)
  skirtX: ['Param25', 'Param26', 'Param27'],
  skirtY: ['Param28', 'Param29', 'Param47'],
  hair: ['Param5', 'Param6', 'Param7'],
  // direct idle writes (orphaned ids — verified: no physics group
  // drives them, no exp3 references them, no choreo track owns them)
  ornaments: [
    'Param30',
    'Param31',
    'Param32',
    'Param33',
    'Param34',
    'Param35',
    'Param48',
    'Param49',
    'Param50',
    'Param51',
    'Param52',
    'Param53',
  ],
  headpiece: [
    'Param14',
    'Param15',
    'Param16',
    'Param17',
    'Param18',
    'Param19',
    'Param41',
    'Param42',
    'Param43',
    'Param44',
    'Param45',
    'Param46',
  ],
};

/** Pre-scale amplitudes per group (param units). */
const AMBIENT_AMPS = {
  skirtX: 3.0,
  skirtY: 1.5,
  hair: 2.0,
  ornaments: 2.5,
  headpiece: 1.2,
};

/** Flat id -> group map for the guard + direct writes. */
export const AMBIENT_OWNED = new Map(
  Object.entries(AMBIENT_CHAINS).flatMap(([group, ids]) => ids.map((id) => [id, group])),
);

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

/**
 * AmbientSway: one instance per model load (owned by the SecondaryLayer),
 * randomized per construction. Computed on the layer clock (single clock
 * discipline — sample(dt) advances it). All channels are pure functions
 * of t: no state, no feedback, no physics input.
 */
export class AmbientSway {
  constructor(cfg = {}) {
    const a = cfg?.ambientSway ?? {};
    this.enabled = a.enabled !== false; // default ON
    this.scale = Number.isFinite(Number(a.scale)) && a.scale >= 0 ? a.scale : 1;
    const g = a.groups ?? {};
    this.groups = {};
    for (const key of ['skirt', 'hair', 'ornaments', 'headpiece']) {
      const v = Number(g[key]);
      this.groups[key] = Number.isFinite(v) && v >= 0 ? v : 1;
    }
    this.fadeIn = 2; // s after attach
    this.t = 0; // ambient clock (layer-clock driven)
    this.t0 = 0; // set at first sample (fade-in anchor)

    // Per-group randomized recipe constants:
    //   P1 5-8 s, P2 = P1*2.7, P3 23-37 s, phi0, phi3, per-segment
    //   period jitter ±0.7 s and phase lag 0.5-0.8 rad.
    this.recipe = {};
    for (const [group, ids] of Object.entries(AMBIENT_CHAINS)) {
      const P1 = rand(5, 8);
      this.recipe[group] = {
        P1,
        P2: P1 * 2.7,
        P3: rand(23, 37),
        phi0: rand(0, Math.PI * 2),
        phi2: rand(0, Math.PI * 2),
        phi3: rand(0, Math.PI * 2),
        lagPhase: rand(0.5, 0.8),
        segP: ids.map(() => rand(-0.7, 0.7)),
      };
    }
  }

  /** Reconfigure (live config edit). Accepts the
   * FLAT hook shape ({ enabled, scale, groups }) — the hook callers
   * pass the ambientSway object itself, not the whole config root.
   * Phases are preserved — only amplitude/enabled change; disabling
   * freezes every channel to exactly 0 (previous still-cloth idle). */
  configure(cfg) {
    const a = cfg ?? {};
    if (a.enabled !== undefined) this.enabled = a.enabled !== false;
    if (a.scale !== undefined) {
      const v = Number(a.scale);
      this.scale = Number.isFinite(v) && v >= 0 ? v : this.scale;
    }
    if (a.groups) {
      for (const key of ['skirt', 'hair', 'ornaments', 'headpiece']) {
        const v = Number(a.groups?.[key]);
        if (Number.isFinite(v) && v >= 0) this.groups[key] = v;
      }
    }
  }

  /** Advance the ambient clock (called from SecondaryLayer.sample). */
  sample(dt) {
    this.t += dt;
  }

  /** Ambient value for one id at the current ambient time (param
   * units, ±30 clamp applied by the writer). Returns 0 when disabled
   * or the id's group is scaled to 0 — the previous still-cloth idle. */
  valueFor(id) {
    if (!this.enabled) return 0;
    const group = AMBIENT_OWNED.get(id);
    if (!group) return 0;
    const ids = AMBIENT_CHAINS[group];
    const i = ids.indexOf(id);
    if (i < 0) return 0;
    // group config key: skirtX/skirtY share "skirt"
    const cfgKey = group === 'skirtX' || group === 'skirtY' ? 'skirt' : group;
    const gs = this.groups[cfgKey];
    if (!gs) return 0;
    const A = AMBIENT_AMPS[group] * this.scale * gs;
    if (!A) return 0;
    const r = this.recipe[group];
    const t = this.t;
    // fade-in: 0 -> 1 over the first 2 s of ambient time
    const fade = Math.min(1, Math.max(0, t / this.fadeIn));
    const segJitter = r.segP[i];
    const phi_i = r.phi0 - i * r.lagPhase;
    const phi2_i = r.phi2 - i * r.lagPhase;
    const v =
      A *
      (0.6 * Math.sin((2 * Math.PI * t) / (r.P1 + segJitter) + phi_i) +
        0.4 * Math.sin((2 * Math.PI * t) / (r.P2 + segJitter * 2.7) + phi2_i) +
        0.35 * Math.sin((2 * Math.PI * t) / r.P3 + r.phi3)) *
      fade;
    return Math.max(-30, Math.min(30, v));
  }
}

/* ------------------------------------------------------------- config --- */

export const SECONDARY_CHAINS = {
  earL: ['Param4', 'Param36', 'Param37'],
  earR: ['Param38', 'Param39', 'Param40'],
  splay: ['Param3'],
  hair: ['Param5', 'Param6', 'Param7'],
  skirt: ['Param25', 'Param26', 'Param27', 'Param28', 'Param29', 'Param47'],
};

/** Families of chains (scale config keys): ear covers earL/earR/splay,
 * hair and skirt their own chains. */
const FAMILY = {
  earL: 'ear',
  earR: 'ear',
  splay: 'ear',
  hair: 'hair',
  skirt: 'skirt',
};

/** Order the skirt x/y chains interleave for a whip so the hem reads as
 * one piece (x chain leads, y chain half a segment behind). skirt is the
 * one family where the two authored chains are ONE visual hem: they get
 * sequence indices 0..2 (x1-3) and 0.5..2.5 (y1-3) so the whip wave
 * crosses them as a single front. */
const SEG_INDEX = {
  earL: [0, 1, 2],
  earR: [0, 1, 2],
  splay: [0],
  hair: [0, 1, 2],
  skirt: [0, 0.5, 1, 1.5, 2, 2.5],
};

const CLAMP_ABS = 30; // per-id clamp (matches every chain's ±30 range)

/* ------------------------------------------------------------- engine --- */

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smoothstep01 = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * SecondaryLayer: instantiated once per attached model (same lifecycle as
 * IdleDriver — created in main.js attachModel, destroyed on detach), fed
 * from idle.js's applyFrame (clock advance + composition), applied by the
 * pipeline wrapper right after physics.evaluate.
 *
 * Computation model: each frame, sources contribute additive targets per
 * (chain, segment); the layer resolves them into per-id values, applies
 * sign + scale, clamps, and writes through core.addParameterValueById —
 * additive on top of the physics-driven base, never replacing it.
 *
 * Pulse objects (all sources):
 *   { chain, seg, amp, t0, dur, shape }
 *     chain: chain key (earL/earR/splay/hair/skirt)
 *     seg:   segment the pulse AIMS at (whip re-timings per segment)
 *     amp:   amplitude in chain units (sign-aware, ±)
 *     t0:    start on the layer clock (seconds)
 *     dur:   duration until fully settled (s)
 *     shape: 'bump' (0→peak→0) | 'step' (hold amp*dur then release)
 * A pulse aimed at segment `seg` of a chain physically delivers to ALL
 * chain segments i via whip timing (see WHIP SEMANTICS above): segment i
 * sees the pulse at t0 + (i - seg) * lag when i >= seg, amplitude scaled
 * by decay^(i - seg). (A pulse aimed at the TIP only moves the tip and
 * everything after it — the natural flick.)
 */
export class SecondaryLayer {
  /**
   * @param {object} coreModel Cubism core (addParameterValueById target)
   * @param {object} cfg loaded per-model config (see module doc)
   */
  constructor(coreModel, cfg = {}) {
    this.core = coreModel;
    this.now = 0; // layer clock (s), advanced from idle.applyFrame's dt
    this.pulses = []; // live pulse list (expression/choreo/API-sourced)
    this.destroyed = false;

    // Per-id existence + index cache — like the idle driver, only ids
    // the rig owns are ever written (missing ids resolve to no-ops).
    this._ids = new Set();
    this._idx = new Map();
    for (const ids of Object.values(SECONDARY_CHAINS)) {
      for (const id of ids) {
        const i = coreModel.getParameterIndex(id);
        if (i >= 0 && i < coreModel.getParameterCount()) {
          this._ids.add(id);
          this._idx.set(id, i);
        }
      }
    }

    // Config: family scale, per-chain sign, whip timing/decay.
    const s = cfg?.secondaryScale ?? {};
    this.scale = {
      ear: Number.isFinite(Number(s.ear)) && s.ear > 0 ? s.ear : 1,
      hair: Number.isFinite(Number(s.hair)) && s.hair > 0 ? s.hair : 1,
      skirt: Number.isFinite(Number(s.skirt)) && s.skirt > 0 ? s.skirt : 1,
    };
    const signs = cfg?.secondarySigns ?? {};
    this.sign = {};
    for (const key of Object.keys(SECONDARY_CHAINS)) {
      const v = Number(signs[key]);
      this.sign[key] = v === -1 || v === 1 ? v : 1;
    }
    const d = cfg?.secondaryDelay;
    this.lag = Number.isFinite(Number(d?.perSegment)) && d.perSegment >= 0 ? d.perSegment : 0.08;
    const k = cfg?.secondaryDecay;
    this.decay =
      Number.isFinite(Number(k?.perSegment)) && k.perSegment > 0 && k.perSegment <= 1
        ? k.perSegment
        : 0.7;

    // Persistent continuous source: { name -> offset } per chain-family
    // key ('earL','earR','splay','hair','skirt'), set by the expression
    // secondary-offset layer each frame (never a pulse list — the
    // expression weights crossfade continuously).
    this.offsets = { earL: 0, earR: 0, splay: 0, hair: 0, skirt: 0 };

    // Ambient channel: the always-on default-idle drift (ambientSway
    // config). Owns its clock through this layer's sample(dt); its
    // post-physics chains (skirt x/y, hair) are written in apply(),
    // and the idle driver reads its orphaned chains (ornaments,
    // headpiece) through valueFor() for direct writes.
    this.ambient = new AmbientSway(cfg);

    console.log(
      `[secondary] ready: chains ${
        Object.entries(SECONDARY_CHAINS)
          .filter(([, ids]) => ids.every((id) => this._ids.has(id)))
          .map(([k]) => k)
          .join(', ') || 'none'
      }; scale ${JSON.stringify(this.scale)}; signs ${JSON.stringify(this.sign)}`,
    );
  }

  destroy() {
    this.destroyed = true;
    this.pulses.length = 0;
  }

  /** Ambient direct-write chain ids (idle driver writes these — the
   * orphaned chains; the skirt/hair ambient chains are written by
   * apply() itself). Split into two accessors so the driver can build
   * its per-attach id list without importing the chain tables. */
  ambientOrnamentIds() {
    return AMBIENT_CHAINS.ornaments;
  }

  ambientHeadpieceIds() {
    return AMBIENT_CHAINS.headpiece;
  }

  /* ---------------------------------------------------------- sources --- */

  /**
   * Fire a one-shot pulse. `t0` defaults to the current layer clock.
   * Public shape (used by helpers + choreo events):
   *   { chain, seg, amp, t0?, dur, shape? }
   */
  fire(pulse) {
    if (this.destroyed) return;
    this.pulses.push({
      chain: pulse.chain,
      seg: pulse.seg ?? 0,
      amp: Number(pulse.amp) || 0,
      t0: Number.isFinite(Number(pulse.t0)) ? pulse.t0 : this.now,
      dur: Math.max(0.05, Number(pulse.dur) || 0.25),
      shape: pulse.shape === 'step' ? 'step' : 'bump',
    });
    // Cap: a runaway source flooding the list never wedges the layer.
    if (this.pulses.length > 64) this.pulses.splice(0, this.pulses.length - 64);
  }

  /**
   * Load this frame's continuous offsets (already crossfaded by the
   * caller — see idle.js expression secondary table). Keys:
   * earL/earR/splay/hair/skirt; numeric, chain-family units.
   */
  setOffsets(off) {
    if (this.destroyed) return;
    for (const key of ['earL', 'earR', 'splay', 'hair', 'skirt']) {
      const v = Number(off?.[key]);
      this.offsets[key] = Number.isFinite(v) ? v : 0;
    }
  }

  /* --------------------------------------------------------- helpers ---
   * The authoring API. `perEar` picks a side: 'L' | 'R' | null(both).
   * All amounts flow through sign + family scale at WRITE time.
   */

  earDroop(amount, perEar = null, dur = 0.3) {
    if (perEar !== 'R') this.fire({ chain: 'earL', seg: 0, amp: amount, dur, shape: 'step' });
    if (perEar !== 'L') this.fire({ chain: 'earR', seg: 0, amp: amount, dur, shape: 'step' });
  }

  earPrick(amount, dur = 0.22) {
    this.fire({ chain: 'earL', seg: 0, amp: -amount, dur, shape: 'step' });
    this.fire({ chain: 'earR', seg: 0, amp: -amount, dur, shape: 'step' });
  }

  earFlick(ear, amp, dur = 0.5) {
    const chain = ear === 'R' ? 'earR' : 'earL';
    this.fire({ chain, seg: 2, amp, dur: Math.max(0.15, dur), shape: 'bump' });
  }

  earSplay(amount) {
    this.fire({ chain: 'splay', seg: 0, amp: amount, dur: 0.25, shape: 'bump' });
  }

  hairWhip(amp, dir = 1, dur = 0.45) {
    this.fire({ chain: 'hair', seg: 0, amp: amp * (dir >= 0 ? 1 : -1), dur, shape: 'bump' });
  }

  skirtWhip(amp, dir = 1) {
    this.fire({ chain: 'skirt', seg: 0, amp: amp * (dir >= 0 ? 1 : -1), dur: 0.5, shape: 'bump' });
  }

  skirtFidget(amp, cycles = 2) {
    // Rapid alternating hem flutter: cycles pairs of ± whips, each
    // 0.22 s, chained back-to-back (nervous fidget).
    const per = 0.22;
    for (let c = 0; c < Math.max(1, Math.round(cycles)); c++) {
      this.fire({
        chain: 'skirt',
        seg: 0,
        amp: amp,
        t0: this.now + c * 2 * per,
        dur: per,
        shape: 'bump',
      });
      this.fire({
        chain: 'skirt',
        seg: 0,
        amp: -amp,
        t0: this.now + (c * 2 + 1) * per,
        dur: per,
        shape: 'bump',
      });
    }
  }

  /* ------------------------------------------------------- evaluation --- */

  /** Advance the layer clock and retire dead pulses. Called from
   * idle.applyFrame with the SAME clamped dt the rest of the frame
   * uses (single clock discipline — no private timers anywhere). The
   * ambient channel advances on the same clock. */
  sample(dt) {
    this.now += dt;
    this.ambient?.sample(dt);
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      // NOTE the parens: `a * b ?? 0` binds as `(a * b) ?? 0`, and an
      // unknown chain's `?.length` is undefined -> `lag * undefined` = NaN
      // -> `NaN ?? 0` is still NaN (?? only catches null/undefined), which
      // would make the retirement test always false and leak every pulse
      // on an unknown chain. Parenthesize first, then fall back to 0.
      const segs = SEG_INDEX[p.chain];
      const tail = segs ? this.lag * (segs.length - 1) : 0;
      if (this.now - p.t0 > p.dur + tail + 0.05) this.pulses.splice(i, 1);
    }
  }

  /** Pulse envelope at time t (0..amp): bump = squared sine (zero
   * velocity at both ends), step = smooth rise, hold, smooth fall. */
  _env(p, t) {
    const u = clamp((t - p.t0) / p.dur, -1, 2);
    if (u < 0) return 0;
    if (p.shape === 'step') {
      // rise 20%, hold 60%, fall 20%
      if (u < 0.2) return smoothstep01(u / 0.2);
      if (u <= 0.8) return 1;
      return 1 - smoothstep01((u - 0.8) / 0.2);
    }
    if (u > 1) return 0;
    const s = Math.sin(Math.PI * u);
    return s * s;
  }

  /** Compose this frame's per-id additive values and WRITE them to the
   * core (addParameterValueById — physics base survives underneath).
   * Called by the pipeline wrapper AFTER physics.evaluate. */
  apply() {
    if (this.destroyed) return;
    const core = this.core;
    // 0) Ambient channel (post-physics chains only: skirt x/y + hair —
    //    additive like everything else in this slot; amplitudes are
    //    small (<=3 pre-scale) so choreo whips still read on top).
    //    The ornaments/headpiece chains are NOT written here — the
    //    idle driver writes those directly (orphaned ids, pre-physics
    //    path) so the ambient drift survives even on models without
    //    a physics pipeline.
    if (this.ambient?.enabled) {
      for (const group of ['skirtX', 'skirtY', 'hair']) {
        for (const id of AMBIENT_CHAINS[group]) {
          if (!this._ids.has(id)) continue;
          const v = this.ambient.valueFor(id);
          if (v) core.addParameterValueById(id, v, 1);
        }
      }
    }
    // 1) Continuous offsets (expressions): flat per-chain values,
    //    delivered to every segment equally at family scale (a held
    //    ear droop reads as a curved pose, not a wave).
    for (const [key, ids] of Object.entries(SECONDARY_CHAINS)) {
      const off = this.offsets[key];
      if (!off) continue;
      const fam = FAMILY[key];
      const v = off * this.scale[fam] * this.sign[key];
      if (!v) continue;
      for (const id of ids) {
        if (!this._ids.has(id)) continue;
        core.addParameterValueById(id, clamp(v, -CLAMP_ABS, CLAMP_ABS), 1);
      }
    }
    // 2) Pulses (choreo/API): whip semantics — a pulse aimed at
    //    segment `seg` reaches segment i (i >= seg) at
    //    t0 + (i - seg) * lag with amplitude × decay^(i - seg).
    for (const p of this.pulses) {
      const ids = SECONDARY_CHAINS[p.chain];
      const idxs = SEG_INDEX[p.chain];
      if (!ids || !idxs) continue;
      const fam = FAMILY[p.chain];
      for (let i = 0; i < ids.length; i++) {
        const segIdx = idxs[i];
        if (segIdx < p.seg) continue; // pulse aimed downstream of this seg
        const delay = (segIdx - p.seg) * this.lag;
        const v =
          this._env(p, this.now - delay) *
          p.amp *
          Math.pow(this.decay, segIdx - p.seg) *
          this.scale[fam] *
          this.sign[p.chain];
        if (!v) continue;
        const id = ids[i];
        if (!this._ids.has(id)) continue;
        core.addParameterValueById(id, clamp(v, -CLAMP_ABS, CLAMP_ABS), 1);
      }
    }
  }
}
