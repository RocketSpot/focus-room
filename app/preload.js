'use strict';
// ============================================================
// preload.js, minimal, whitelisted bridge for Electron windows.
// The TV/boot window talks to the server over a plain WebSocket (exactly as
// the iPad does, so its rendering path is identical). The hidden diagnostic
// window gets a richer IPC channel: the live sidecar feed + the ability to
// fire commands (e.g. the SDK test signal) straight at the sidecar.
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

// The launcher hands each window a build-gated DISPLAY config via additionalArguments (base64 JSON,
// a private process channel). staff.uiEnabled is false in production guest builds; staff.pin is a
// locally configured credential (FOCUSROOM_STAFF_TOKEN), empty ⇒ PIN unlock disabled. A page with no
// launcher (a plain browser on the LAN surface) gets the locked default: no staff UI. The raw-EEG
// capability token is DELIBERATELY not here (finding #5), see the raw relay below.
function windowConfig() {
  try {
    const arg = (process.argv || []).find((a) => a.indexOf('--focusroom-cfg=') === 0);
    if (!arg) return { staff: { uiEnabled: false, pin: '' } };
    const c = JSON.parse(Buffer.from(arg.slice('--focusroom-cfg='.length), 'base64').toString('utf8'));
    const s = c.staff || {};
    return { staff: { uiEnabled: s.uiEnabled === true, pin: typeof s.pin === 'string' ? s.pin : '' } };
  } catch (e) {
    return { staff: { uiEnabled: false, pin: '' } };
  }
}
const _cfg = windowConfig();

// ---- authenticated raw-EEG relay (finding #5 credential containment) ----
// Raw config/raw/quality arrive from the MAIN process over IPC (main holds the capability token and
// authorizes delivery by process boundary, the renderer never receives, stores, or can read the
// token). The preload forwards them to the page ONLY through subscribeRawEeg(); NO token accessor is
// exposed, and there is no raw WebSocket in the renderer. Sandbox-safe (ipcRenderer only).
let _rawSubs = [];
function _relayRaw(m) { if (m && typeof m.type === 'string') for (const cb of _rawSubs) { try { cb(m); } catch (_) {} } }
ipcRenderer.on('rawEeg:msg', (_evt, m) => _relayRaw(m));

contextBridge.exposeInMainWorld('__FOCUSROOM__', {
  staff: _cfg.staff,
  // Subscription-only raw access. Returns an unsubscribe fn. NO token is ever exposed to the page.
  // On subscribe, replay the last config + quality so a freshly-loaded signal surface isn't blank.
  subscribeRawEeg(cb) {
    if (typeof cb !== 'function') return () => {};
    _rawSubs.push(cb);
    ipcRenderer.invoke('rawEeg:last').then((last) => {
      if (last && last.config) { try { cb(last.config); } catch (_) {} }
      if (last && last.quality) { try { cb(last.quality); } catch (_) {} }
    }).catch(() => {});
    return () => { _rawSubs = _rawSubs.filter((f) => f !== cb); };
  },
});

const IN_CHANNELS = new Set([
  'sidecar:message',
  'sidecar:status',
  'sidecar:stderr',
  'surface:client',
]);

contextBridge.exposeInMainWorld('focusroom', {
  // subscribe to a diagnostic feed channel; returns an unsubscribe fn
  on(channel, cb) {
    if (!IN_CHANNELS.has(channel)) return () => {};
    const handler = (_evt, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  // send a command to the sidecar (validated against the contract in main)
  command(type, payload) {
    return ipcRenderer.invoke('diag:command', { type, payload });
  },
  info() {
    return ipcRenderer.invoke('diag:info');
  },
});
