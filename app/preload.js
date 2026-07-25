'use strict';
// ============================================================
// preload.js — minimal, whitelisted bridge for Electron windows.
// The TV/boot window talks to the server over a plain WebSocket (exactly as
// the iPad does, so its rendering path is identical). The hidden diagnostic
// window gets a richer IPC channel: the live sidecar feed + the ability to
// fire commands (e.g. the SDK test signal) straight at the sidecar.
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

// Pre-merge hardening: the launcher hands each window a build-gated staff/engineering config
// via additionalArguments (base64 JSON). uiEnabled is false in production guest builds; pin is a
// locally configured credential (FOCUSROOM_STAFF_TOKEN), empty ⇒ PIN unlock disabled. A page with
// no launcher (a plain browser hitting the LAN surface) gets the locked default {uiEnabled:false}.
function staffConfig() {
  try {
    const arg = (process.argv || []).find((a) => a.indexOf('--focusroom-staff=') === 0);
    if (!arg) return { uiEnabled: false, pin: '' };
    const c = JSON.parse(Buffer.from(arg.slice('--focusroom-staff='.length), 'base64').toString('utf8'));
    return { uiEnabled: c.uiEnabled === true, pin: typeof c.pin === 'string' ? c.pin : '' };
  } catch (e) {
    return { uiEnabled: false, pin: '' };
  }
}
contextBridge.exposeInMainWorld('__FOCUSROOM__', { staff: staffConfig() });

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
