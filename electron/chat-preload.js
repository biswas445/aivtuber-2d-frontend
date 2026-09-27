const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatPanel', {
  /** Toggle always-on-top for this window. Returns the new state. */
  togglePin: () => ipcRenderer.invoke('chat:toggle-pin'),
  /** Toggle background transparency. Returns true when now OPAQUE. */
  toggleTransparent: () => ipcRenderer.invoke('chat:toggle-transparent'),
  /** Close the chat panel window. */
  close: () => ipcRenderer.send('chat:close'),

  /** The BotRix multistream widget URL to embed (from BOTRIX_WIDGET_URL). */
  getWidgetUrl: () => ipcRenderer.invoke('chat:get-widget-url'),

  /** Viewer counts: { total, twitch, youtube, kick } pushed every ~30s. */
  onViewers: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('chat:viewers', listener);
    return () => ipcRenderer.removeListener('chat:viewers', listener);
  },

  /** Persistent-ish window state for the renderer to restore its UI from. */
  getState: () => ipcRenderer.invoke('chat:get-state'),
});
