'use strict';
// ============================================================
// preload.js — minimal, whitelisted bridge for Electron windows.
// The TV/boot window talks to the server over a plain WebSocket (exactly as
// the iPad does, so its rendering path is identical). The hidden diagnostic
// window gets a richer IPC channel: the live sidecar feed + the ability to
// fire commands (e.g. the SDK test signal) straight at the sidecar.
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

// The launcher hands each window a build-gated config via additionalArguments (base64 JSON, a
// private process channel). staff.uiEnabled is false in production guest builds; staff.pin is a
// locally configured credential (FOCUSROOM_STAFF_TOKEN), empty ⇒ PIN unlock disabled. rawStreamToken
// is the per-launch raw-EEG capability token (finding #5). A page with no launcher (a plain browser
// hitting the LAN surface) gets the locked default: no staff UI and no raw token.
function windowConfig() {
  try {
    const arg = (process.argv || []).find((a) => a.indexOf('--focusroom-cfg=') === 0);
    if (!arg) return { staff: { uiEnabled: false, pin: '' }, rawStreamToken: '' };
    const c = JSON.parse(Buffer.from(arg.slice('--focusroom-cfg='.length), 'base64').toString('utf8'));
    const s = c.staff || {};
    return {
      staff: { uiEnabled: s.uiEnabled === true, pin: typeof s.pin === 'string' ? s.pin : '' },
      rawStreamToken: typeof c.rawStreamToken === 'string' ? c.rawStreamToken : '',
    };
  } catch (e) {
    return { staff: { uiEnabled: false, pin: '' }, rawStreamToken: '' };
  }
}
const _cfg = windowConfig();
contextBridge.exposeInMainWorld('__FOCUSROOM__', {
  staff: _cfg.staff,
  // Exposed as a FUNCTION, never a globally readable string: the authorized TV page calls it to
  // build its authenticated WS hello. A non-launcher page has no preload, so this is absent.
  rawStreamToken: function () { return _cfg.rawStreamToken || ''; },
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
