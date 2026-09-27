# AI VTuber 2D Frontend — Live2D Desktop Companion

An always-on-top, transparent **Live2D Cubism desktop companion** (airi-vtuber
style) built with **Electron + PixiJS + pixi-live2d-display**, plus a
multistream chat overlay powered by the official **BotRix** widget
(Twitch / YouTube / Kick in one panel, with live viewer counts).

The companion sits on top of everything, is click-through everywhere except
the character herself, breathes and sways with procedural idle physics,
reacts to pokes and pats, plays authored animations, and can be dragged,
scaled and pinned anywhere on your screen.

## Features

- 🎭 **Transparent, borderless, always-on-top overlay window** — the renderer
  hit-tests the character and toggles window interactivity over IPC, so clicks
  on empty space fall through to whatever app is underneath.
- 🌸 **Live2D Cubism 4 rendering** via [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)
  on PixiJS 6, with full SDK physics (hair, ribbons, clothes) kept live.
- 🎬 **Procedural idle system** — a hand-authored IdleDriver blends breathing,
  blinking, glances, weight shifts and ambient sway on top of physics, with
  true crossfades so animation hand-offs never snap.
- 🕺 **Choreography engine** — keyframed secondary-motion chains (skirt sway,
  hair follow-through, ear physics) authored per model via `choreo-config.json`.
- ✋ **Interactions** — poke/pat reactions, expressions (smile, angry, love,
  sleepy, …), custom motions (nod-yes, shake-no, look-back).
- 🛠️ **Edit mode** — drag, resize and reposition the companion with on-screen
  handles; position survives restarts.
- 💬 **Multistream chat panel** — embeds the official BotRix widget page
  (the exact one OBS loads), aggregating **Twitch + YouTube + Kick chat**,
  with per-platform viewer counts polled from BotRix's REST API.
- 🧷 **Tray menu** — pin/unpin, switch model, toggle chat, quit; the overlay
  survives renderer crashes (auto-reload) and logs errors to `error.log`.
- 🔒 **CSP-locked renderer** — `script-src 'self'`, no remote code; model files
  are served through a custom `vtuber-model://` protocol in dev *and* packaged
  builds, with fuzzy path resolution for archives with mojibake filenames.

## Architecture

| Piece | What it does |
| --- | --- |
| `electron/main.js` | Main process: overlay window, tray, click-through IPC, `vtuber-model://` protocol, viewer-count polling, `.env` reading |
| `src/main.js` | Renderer entry: PixiJS stage, Live2D model attach, controls toolbar |
| `src/idle.js` | IdleDriver — procedural idle/blinks/glances with crossfade blending |
| `src/choreo.js` | ChoreoEngine — keyframed animation authoring & playback |
| `src/secondary.js` | Secondary layer — additive physics-driven secondary motion chains |
| `src/overlay.js` | Overlay UX: hit-testing, pokes, hover states |
| `src/edit-mode.js` | Move/scale edit mode with resize handles |
| `chat.html` + `src/chat.js` | Multistream chat panel (BotRix widget + viewer pills) |
| `public/live2d/` | `live2dcubismcore.min.js` — Live2D Cubism Core runtime |

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) 18+ (Vite 7 requires 18/20+)
- A **Live2D Cubism 4 model** you have the rights to use (see below)

### Install

```bash
git clone https://github.com/biswas445/aivtuber-2d-frontend.git
cd aivtuber-2d-frontend
npm install
```

### Add a Live2D model

Models are **not** bundled with this repo — Live2D models are copyrighted by
their creators/riggers, so ship your own. The app loads every model it finds
under a **sibling folder** of the repo:

```
parent-dir/
├── aivtuber-2d-frontend/     ← this repo
└── character_models/
    └── your-model/
        ├── your-model.model3.json
        ├── your-model.moc3
        ├── your-model.physics3.json
        ├── textures/
        ├── motions/
        └── expressions/
```

Free models to test with: [Live2D sample data](https://www.live2d.com/en/learn/sample/),
or any Cubism 4 rig you own. Optional per-model tuning files
(`choreo-config.json`, `model-dump.json`) are auto-detected when present.

### Optional: multistream chat panel

```bash
cp .env.example .env
# then edit .env and paste your widget URL from https://botrix.live
```

`BOTRIX_WIDGET_URL` is the exact browser-source URL BotRix gives you; it is
kept in `.env` (gitignored) because its `bid` is a private session id.

### Run

```bash
npm run dev    # Vite dev server + Electron with hot reload
npm start      # production build + launch
npm run build  # vite build only (dist/renderer)
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Vite dev server (127.0.0.1:5173) + Electron, concurrently |
| `npm run build` | Production build to `dist/renderer` |
| `npm start` | Build then launch via `electron/launch.js` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier write |

## Privacy & security notes

- `.env` (BotRix widget URL / session id) is **gitignored — never commit it**.
- The renderer runs under a strict CSP; all model I/O goes through the
  `vtuber-model://` protocol, not arbitrary `file://` access.
- Unexpected main-process errors are appended to `error.log` under the
  Electron `userData` directory for post-mortem debugging.

## License

All rights reserved by the author for now — add a `LICENSE` file before
others reuse the code.
