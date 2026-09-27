/**
 * Chat panel renderer: the SAME panel frontend as before (header chrome,
 * heart title, status dot, drag handle, pin / transparency / close buttons,
 * glass + solid themes) — with the official BotRix multistream widget
 * embedded where the message list used to be.
 *
 * Why embed: the widget page (the exact URL OBS loads) is BotRix's own
 * display client. It maintains every platform connection — twitch,
 * youtube AND kick — normalizes, styles, and scrolls the messages itself.
 * All three platforms work with zero protocol code on our side, and the
 * panel keeps its native look around it.
 *
 * The widget URL comes from the main process (BOTRIX_WIDGET_URL in
 * frontend/.env — read by electron/main.js getBotrixWidgetUrl), so the
 * bid/session is configured in one place.
 */

const api = window.chatPanel;

const statusEl = document.getElementById('chat-status');
const pinBtn = document.getElementById('btn-pin');
const transparentBtn = document.getElementById('btn-transparent');
const frame = document.getElementById('chat-frame');
const viewerWrap = document.getElementById('viewer-counts');
const viewerPills = {
  twitch: viewerWrap.querySelector('.vc-twitch .n'),
  youtube: viewerWrap.querySelector('.vc-youtube .n'),
  kick: viewerWrap.querySelector('.vc-kick .n'),
};
const viewerPillEls = {
  twitch: viewerWrap.querySelector('.vc-twitch'),
  youtube: viewerWrap.querySelector('.vc-youtube'),
  kick: viewerWrap.querySelector('.vc-kick'),
};

// status line: cosmetic now — the widget manages its own connection; we
// label the source so it's visible at a glance. Built with DOM APIs,
// never innerHTML.
function setStatus(text, live) {
  statusEl.classList.toggle('live', Boolean(live));
  statusEl.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'dot';
  statusEl.appendChild(dot);
  const label = document.createElement('span');
  label.textContent = text;
  statusEl.appendChild(label);
}

// ---- wire buttons ------------------------------------------------------------

pinBtn.addEventListener('click', async () => {
  const on = await api.togglePin(); // invoke() returns a Promise — await it,
  pinBtn.classList.toggle('active', on); // or the button state desyncs
});

transparentBtn.addEventListener('click', async () => {
  const on = await api.toggleTransparent(); // true = transparent OFF (solid)
  document.body.classList.toggle('opaque', on);
  transparentBtn.classList.toggle('active', !on);
});

document.getElementById('btn-close').addEventListener('click', () => api.close());

// ---- viewer counts ------------------------------------------------------------
// Pushed from the main process every ~30s (BotRix viewers REST polling).
// One pill per platform behind the title: [icon] count; green when that
// platform has viewers, gray at 0. Counts are textContent — safe updates.

api.onViewers((v) => {
  viewerWrap.style.display = 'inline-flex';
  // Iterate the array literal directly (Object.entries on an array yields
  // [index, element] pairs — platform would read '0'/'1'/'2', numEl would
  // be the inner array, and pillEl undefined → TypeError every poll).
  for (const [platform, numEl, pillEl] of [
    ['twitch', viewerPills.twitch, viewerPillEls.twitch],
    ['youtube', viewerPills.youtube, viewerPillEls.youtube],
    ['kick', viewerPills.kick, viewerPillEls.kick],
  ]) {
    const n = v && Number.isFinite(Number(v[platform])) ? Math.max(0, Number(v[platform])) : 0;
    numEl.textContent = String(n);
    pillEl.classList.toggle('live', n > 0);
  }
});

// ---- initial state ------------------------------------------------------------

(async () => {
  const st = await api.getState();
  pinBtn.classList.toggle('active', st.pinned);
  document.body.classList.toggle('opaque', !st.transparent);
  transparentBtn.classList.toggle('active', !st.transparent);

  // load the widget (the main process supplies the URL)
  const url = await api.getWidgetUrl();
  if (url) {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      /* malformed config — treated as unloadable below */
    }
    if (parsed && parsed.protocol === 'https:') {
      // The CSP permits only https: frames; anything else would be a
      // SILENTLY blank iframe — say so instead.
      frame.src = url;
      setStatus(`botrix multistream · ${parsed.hostname}`, true);
      // A load failure (bad bid, widget down, host refuses embedding)
      // leaves the frame blank — surface it: no did-finish-load within a
      // grace window flips the status to an explicit offline state.
      const loadWatch = setTimeout(() => {
        setStatus('widget failed to load — check BOTRIX_WIDGET_URL', false);
      }, 15000);
      frame.addEventListener('load', () => clearTimeout(loadWatch), { once: true });
      frame.addEventListener(
        'error',
        () => {
          clearTimeout(loadWatch);
          setStatus('widget failed to load — check BOTRIX_WIDGET_URL', false);
        },
        { once: true },
      );
    } else {
      setStatus('widget url must be https:// — check BOTRIX_WIDGET_URL', false);
    }
  } else {
    setStatus('no widget url configured', false);
  }
})();
