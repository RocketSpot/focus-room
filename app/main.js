'use strict';
// ============================================================
// Zone — The Focus Room :: Electron main process (the room SHELL)
// ------------------------------------------------------------
// The room's BRAIN — sidecar supervision, LAN surface server, the
// orchestrator, outputs, ops gate, crash guard — lives in room-core.js
// (shared with the headless web deployment). This file adds what only
// the physical room has: the TV window on the 100" screen, the hidden
// room-sound host, the Ctrl+Shift+D shortcut, and the app lifecycle.
// ============================================================
const { app, BrowserWindow, screen, globalShortcut, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const config = require('./config');
const crypto = require('crypto');
const { createRoom } = require('./room-core');

// EPHEMERAL raw-EEG capability token (finding #5): 256-bit cryptographically-random, generated
// ONCE per launcher process and rotated every restart. NOT the staff token, NOT in source, config,
// URL, storage, logs, or capture files. Handed to the server (to verify) and, via the preload's
// private additionalArguments channel, to the authorized TV renderer (to present in its hello).
const rawStreamToken = crypto.randomBytes(32).toString('hex');
const { SIDECAR_IN } = require('./protocol');

// Single instance only — one room, one brain.
if (!app.requestSingleInstanceLock()) { app.quit(); }

// The room sound (room-audio.html) is a generative Web Audio engine in a hidden
// window; let its AudioContext start without a click. Opt out with FOCUSROOM_NO_AUDIO=1.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const ROOM_AUDIO = process.env.FOCUSROOM_NO_AUDIO !== '1';

// The shipped app carries ZERO framework chrome: no stock menu (its Help links
// would be the only "Electron" a guest could ever find). macOS keeps a minimal
// named menu — Cmd+Q, copy/paste for the ops pages, and the native fullscreen
// toggle live there; Windows gets no menu at all (F11 is wired on the TV
// window directly).
function installMenu() {
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({ applicationName: 'Zone Focus Room', applicationVersion: app.getVersion() });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

let tvWindow = null;
let audioWindow = null; // persistent hidden host for the brain-state room sound
let diagWindow = null;  // legacy Electron diagnostics window (normally null)
let tvSurface = null;   // which TV surface is currently loaded

const room = createRoom({
  onDiag: (channel, payload) => {
    if (diagWindow && !diagWindow.isDestroyed()) diagWindow.webContents.send(channel, payload);
  },
  // Deliver the live raw-EEG stream to the AUTHORIZED TV renderer over IPC (finding #5 containment) —
  // and ONLY while the signal surface is shown, so raw never even enters the renderer on other beats.
  // The token stays in main; the renderer receives only the config/raw/quality messages it renders.
  onRawEeg: (msg) => {
    if (tvSurface === 'signal' && tvWindow && !tvWindow.isDestroyed()) {
      try { tvWindow.webContents.send('rawEeg:msg', msg); } catch (_) {}
    }
  },
  // The orchestrator drives which TV surface shows for the current beat.
  onBeat: ({ surface }) => navigateTv(surface),
  // a TV window that loaded before the bind is showing a URL nothing
  // served — (re)navigate it to the correct surface now.
  onServerUp: () => {
    if (tvWindow && !tvWindow.isDestroyed()) tvWindow.loadURL(tvUrlFor(tvSurface));
    if (audioWindow && !audioWindow.isDestroyed()) audioWindow.loadURL(audioUrl());
  },
});
const { supervisor, server, orchestrator } = room;
// Configure server-side raw-EEG authorization: verify the launcher token, and require a loopback
// socket (finding #5 §3: loopback-only by default — including during FOCUSROOM_VALIDATION=1 and any
// packaged/guest/launcher-driven mode; a non-loopback raw connection needs the explicit dev opt-in
// FOCUSROOM_ALLOW_REMOTE_RAW=1, which is ignored when packaged or validating). Fail-closed.
server.configureRawAuth({ token: rawStreamToken, requireLoopback: config.RAW_REQUIRE_LOOPBACK });
if (!config.RAW_REQUIRE_LOOPBACK) {
  // dev-only, ignored in packaged/validation. Logged WITHOUT the token.
  console.warn('[security] FOCUSROOM_ALLOW_REMOTE_RAW=1 — non-loopback raw connections permitted (dev only).');
}

// Raw EEG reaches the authorized TV renderer over Electron IPC (finding #5 containment): the token
// NEVER leaves the main process — not additionalArguments, not process.argv, not the renderer. The
// live raw stream is pushed from room-core's onRawEeg hook (below, gated to the signal surface); a
// freshly-loaded signal surface asks for the last config/quality via this sender-gated handler.
ipcMain.handle('rawEeg:last', (evt) => {
  if (tvWindow && !tvWindow.isDestroyed() && evt.sender === tvWindow.webContents) {
    try { return room.lastEegState ? room.lastEegState() : { config: null, quality: null }; } catch (_) { return { config: null, quality: null }; }
  }
  return { config: null, quality: null };
});

// ---------------- TV surface switching ----------------
function tvUrlFor(surface) {
  const file = surface === 'orb' ? 'tv-orb.html'
    : surface === 'signal' ? 'tv-signal.html'
    : surface === 'live' ? 'tv-live.html'
    : surface === 'reveal' ? 'tv-reveal.html'
    : 'tv-constellation.html';
  // Pre-merge hardening (item 2): the engineering view's staff unlock is enabled ONLY in a
  // dev/staff build. In a packaged production guest build config.isDev is false, so no staff
  // param is appended and the surface stays locked (the preload also reports staffUiEnabled).
  const q = (config.isDev && surface === 'signal') ? '?staff=1' : '';
  return `http://127.0.0.1:${config.net.LAN_PORT}/${file}${q}`;
}

// Per-window config handed to the preload via additionalArguments (base64 JSON, a private
// process channel — not a URL/query param). Carries ONLY the staff DISPLAY-gate config (item 1/2:
// uiEnabled is false in production guest builds; the PIN is FOCUSROOM_STAFF_TOKEN, empty ⇒ disabled).
// The raw-EEG capability token is NOT here (finding #5 containment): it must never appear in
// additionalArguments / process.argv / the OS command line. It is delivered separately, on demand,
// via sender-gated Electron IPC to the TV window's preload only, and never reaches page JavaScript.
function windowConfigArg() {
  const cfg = { staff: { uiEnabled: !!config.isDev, pin: process.env.FOCUSROOM_STAFF_TOKEN || '' } };
  return '--focusroom-cfg=' + Buffer.from(JSON.stringify(cfg)).toString('base64');
}
function navigateTv(surface) {
  if (!surface || surface === tvSurface) return;
  tvSurface = surface;
  if (tvWindow && !tvWindow.isDestroyed()) tvWindow.loadURL(tvUrlFor(surface));
}

// ---------------- windows ----------------
function createTvWindow() {
  const displays = screen.getAllDisplays();
  const external = displays.find((d) => d.bounds.x !== 0 || d.bounds.y !== 0);
  const target = external || screen.getPrimaryDisplay();

  tvWindow = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: config.isDev && !external ? 1280 : target.bounds.width,
    height: config.isDev && !external ? 720 : target.bounds.height,
    backgroundColor: '#0B0B0A', // room-black around the TV
    fullscreen: !!external,     // fullscreen the real 100" TV; windowed in dev
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,           // §4: renderer containment (already on)
      nodeIntegration: false,           // §4
      devTools: !config.isPackaged,     // §4: no DevTools in packaged guest mode
      additionalArguments: [windowConfigArg()],   // build-gated staff DISPLAY config (NO raw token)
    },
  });
  // §4 renderer containment for the raw-EEG surface: deny remote navigation + window.open, so a
  // compromised/opened page cannot exfiltrate raw EEG or load third-party script. Only the app's
  // own local surfaces may load. (CSP is applied server-side to the tv-*.html responses.)
  tvWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  tvWindow.webContents.on('will-navigate', (e, url) => {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost):/i.test(String(url || ''))) e.preventDefault();
  });
  // Load the served TV surface for the current beat (idle → constellation). The
  // orchestrator switches surfaces by beat via navigateTv(). Each surface renders
  // with its own tokens/fonts/FocusLine and connects to the WebSocket.
  tvSurface = orchestrator.beat === 'reading' || orchestrator.beat === 'strongest' ? 'orb'
    : orchestrator.beat === 'fit' ? 'signal'
    : orchestrator.beat === 'standby' ? 'reveal' : 'constellation';
  tvWindow.loadURL(tvUrlFor(tvSurface));
  tvWindow.once('ready-to-show', () => tvWindow.show());
  // F11 toggles fullscreen on the TV (the window has no menu to offer it);
  // macOS also has the native green button + Ctrl+Cmd+F from the View menu.
  tvWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      e.preventDefault();
      if (tvWindow && !tvWindow.isDestroyed()) tvWindow.setFullScreen(!tvWindow.isFullScreen());
    }
  });
  tvWindow.on('closed', () => {
    tvWindow = null;
    // tear the hidden audio host down with the TV so the app can actually quit
    if (audioWindow && !audioWindow.isDestroyed()) audioWindow.close();
  });
}

// The room sound lives in its OWN hidden, always-loaded window so it never
// reloads (and never glitches) when the TV switches surfaces beat to beat. It
// connects to the same WebSocket as any surface and plays continuously,
// breathing with the live EEG. Audio goes to the OS default output → room speakers.
function audioUrl() { return `http://127.0.0.1:${config.net.LAN_PORT}/room-audio.html`; }
function createAudioWindow() {
  if (!ROOM_AUDIO || (audioWindow && !audioWindow.isDestroyed())) return;
  audioWindow = new BrowserWindow({
    width: 320, height: 200,
    show: false,          // invisible host — it is heard, not seen
    skipTaskbar: true,
    webPreferences: {
      backgroundThrottling: false, // a hidden window must NOT throttle its audio/timers
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  audioWindow.loadURL(audioUrl());
  audioWindow.on('closed', () => { audioWindow = null; });
}

// The operator console is now a SERVED page (ops.html), not an Electron window —
// so it opens in a browser and is reachable from any device on the room network
// (the operator's phone, a laptop). Ctrl+Shift+D just opens it in the default
// browser. Its telemetry + controls ride the same LAN WebSocket the iPad/TV use.
function openOpsConsole() {
  const url = `http://localhost:${config.net.LAN_PORT}/ops.html`;
  shell.openExternal(url).catch((e) => console.error('[ops] could not open console:', e.message));
}

// Ctrl/Cmd+Shift+U — flash the iPad URL(s) on the TV itself. Setting up the
// room means standing at the TV wondering what to type into Safari; this
// answers it on the biggest screen in the room, then fades away.
function showLanUrlToast() {
  if (!tvWindow || tvWindow.isDestroyed()) return;
  let urls = [];
  try { urls = server.lanUrls ? server.lanUrls() : []; } catch (_) {}
  if (!urls.length) urls = [`http://localhost:${config.net.LAN_PORT}/ipad-flow.html`];
  const html = urls.map((u) => u.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))).join('<br>');
  tvWindow.webContents.executeJavaScript(`(function(){
    var old = document.getElementById('__lanToast'); if (old) old.remove();
    var t = document.createElement('div'); t.id = '__lanToast';
    t.style.cssText = 'position:fixed;left:50%;bottom:7%;transform:translateX(-50%);z-index:99999;'
      + 'background:rgba(15,15,14,0.94);border:1px solid rgba(221,202,142,0.35);border-radius:14px;'
      + 'padding:22px 34px;font-family:\"IBM Plex Mono\",ui-monospace,monospace;font-size:22px;'
      + 'letter-spacing:0.08em;line-height:1.7;color:#DDCA8E;text-align:center;'
      + 'box-shadow:0 12px 60px rgba(0,0,0,0.6);transition:opacity 600ms;';
    t.innerHTML = '<div style=\"font-size:13px;letter-spacing:0.22em;color:#7A7873;margin-bottom:8px\">OPEN ON THE IPAD</div>${html.replace(/'/g, "\\'")}';
    document.body.appendChild(t);
    setTimeout(function(){ t.style.opacity = '0'; setTimeout(function(){ t.remove(); }, 700); }, 8000);
  })()`).catch(() => {});
}

// Diagnostic-window commands (e.g. inject the SDK test signal end-to-end).
ipcMain.handle('diag:command', (_evt, { type, payload }) => {
  if (!Object.values(SIDECAR_IN).includes(type)) return { ok: false, error: 'unknown command' };
  const ok = supervisor.send(type, payload || {});
  return { ok };
});
ipcMain.handle('diag:info', () => ({
  sidecar: supervisor.info,
  server: { port: config.net.LAN_PORT, lanUrls: server.lanUrls?.() || [] },
  simulate: config.SIMULATE,
  isDev: config.isDev,
}));

// ---------------- lifecycle ----------------
app.whenReady().then(async () => {
  installMenu();
  // Dev runs use the stock Electron shell, whose Dock icon is the one piece of
  // Electron branding a guest could ever see — replace it with the room's orb.
  // (The packaged app carries its own icns; this only matters unpackaged.)
  if (process.platform === 'darwin' && app.dock && !config.isPackaged) {
    try { app.dock.setIcon(path.join(config.repoRoot, 'build', 'resources', 'icon.png')); } catch (_) {}
  }
  room.banner(config.isDev ? 'DEV' : 'PACKAGED');
  room.wireSidecar();
  room.wireSurfaces();

  room.startServerWithRetry(); // never rejects; retries in the background if the port is busy

  await supervisor.start();

  globalShortcut.register('CommandOrControl+Shift+D', openOpsConsole);
  globalShortcut.register('CommandOrControl+Shift+U', showLanUrlToast);

  createTvWindow();
  createAudioWindow(); // hidden generative room-sound host (no-op if FOCUSROOM_NO_AUDIO=1)

  app.on('activate', () => {
    // recreate BOTH windows on a macOS dock reactivation — closing the TV also
    // closed the hidden audio host, and bringing back only the TV left the
    // room silent until a full restart
    if (BrowserWindow.getAllWindows().length === 0) { createTvWindow(); createAudioWindow(); }
  });
});

app.on('second-instance', () => {
  if (tvWindow) { if (tvWindow.isMinimized()) tvWindow.restore(); tvWindow.focus(); }
});

app.on('window-all-closed', () => {
  // The room app keeps running headless brain even if windows close in dev;
  // but on Windows/Linux convention we quit. Keep mac alive.
  if (process.platform !== 'darwin') app.quit();
});

const cleanup = () => room.cleanup(async () => globalShortcut.unregisterAll());
let quitting = false;
app.on('before-quit', (e) => {
  if (!quitting) { quitting = true; e.preventDefault(); cleanup().then(() => app.quit()); }
});
app.on('will-quit', () => globalShortcut.unregisterAll());

// crash guard: log + cleanup live in the core; the Electron shell decides how
// to come back (relaunch unless the loop breaker says stay down)
room.attachCrashGuard((looping) => {
  if (!looping) app.relaunch();
  app.exit(1);
});
