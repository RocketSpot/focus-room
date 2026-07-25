'use strict';
// ============================================================
// preload.js — minimal, whitelisted bridge for Electron windows.
// The TV/boot window talks to the server over a plain WebSocket (exactly as
// the iPad does, so its rendering path is identical). The hidden diagnostic
// window gets a richer IPC channel: the live sidecar feed + the ability to
// fire commands (e.g. the SDK test signal) straight at the sidecar.
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

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
