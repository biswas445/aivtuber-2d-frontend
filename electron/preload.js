const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  /** Toggle click-through for the whole window. */
  setIgnoreMouse: (ignore) => ipcRenderer.send('overlay:set-ignore', ignore),

  /** Dragging: grab offset is window-relative; moves use screen coords. */
  dragStart: (grabX, grabY) => ipcRenderer.send('overlay:drag-start', grabX, grabY),
  dragMove: (screenX, screenY) => ipcRenderer.send('overlay:drag-move', screenX, screenY),
  dragEnd: () => ipcRenderer.send('overlay:drag-end'),

  togglePin: () => ipcRenderer.invoke('overlay:toggle-pin'),
  toggleTrackMouse: () => ipcRenderer.invoke('overlay:toggle-track-mouse'),
  /** Multistream chat panel (separate window) show/hide. */
  toggleChat: () => ipcRenderer.invoke('overlay:toggle-chat'),
  getState: () => ipcRenderer.invoke('overlay:get-state'),
  setModel: (rel) => ipcRenderer.invoke('overlay:set-model', rel),
  /** Fallback physics discovery: list *.physics3.json files in a model's
   * folder (rel path) so the renderer can fall back when a model3.json
   * lacks a FileReferences.Physics entry. Empty array when none. */
  findPhysics: (rel) => ipcRenderer.invoke('overlay:find-physics', rel),
  /** Persist the character size multiplier (bigger/smaller buttons) so it
   * survives app restarts. Returns the clamped value. */
  setScaleMul: (mul) => ipcRenderer.invoke('overlay:set-scale-mul', mul),

  /** Container edit modes: 'off' | 'container' | 'character'. */
  setEditMode: (mode) => ipcRenderer.invoke('overlay:set-edit-mode', mode),
  /** Resize/move the overlay window itself (bounds in screen coords) — the
   * window is the container the character is fitted into. */
  setWindowBounds: (bounds) => ipcRenderer.send('overlay:set-window-bounds', bounds),
  /** Persist the character offset (fractions of the window). */
  setCharOffset: (charOffset) => ipcRenderer.send('overlay:set-char-offset', charOffset),

  close: () => ipcRenderer.send('overlay:close'),

  onStateChanged: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('overlay:state-changed', listener);
    return () => ipcRenderer.removeListener('overlay:state-changed', listener);
  },
  onModelChanged: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('overlay:model-changed', listener);
    return () => ipcRenderer.removeListener('overlay:model-changed', listener);
  },

  /** Global cursor position (window-relative), streamed while the pointer
   * is OUTSIDE the window (in-window moves reach the renderer's own
   * mousemove listener — no IPC hop). */
  onCursor: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('overlay:cursor', listener);
    return () => ipcRenderer.removeListener('overlay:cursor', listener);
  },
});
