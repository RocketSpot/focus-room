'use strict';
// ============================================================
// Zone — The Focus Room :: headless WEB entry (no Electron)
// ------------------------------------------------------------
// The whole room brain on a web host (Replit or any Node box):
//   TV        →  /tv.html            (beat-following shell, fullscreen it)
//   guest     →  /ipad-flow.html?kiosk=1
//   operator  →  /ops.html
// Simulated EEG only — a cloud VM has no Bluetooth radio, so the web room
// always runs the deterministic sim source. Real earbuds stay physical.
//
// Launch:  FOCUSROOM_SIMULATE=1 node app/web-main.js
// Env:     PORT (honored automatically) · FOCUSROOM_PYTHON (default python3
//          here) · FOCUSROOM_DATA_DIR · POSTMARK_API_KEY (email; optional)
// ============================================================

// Two signal modes (set BEFORE config resolves):
//   default          — local SIM sidecar on stock python3 (a cloud VM has no
//                      Bluetooth radio, so local signal is sim-by-definition)
//   FOCUSROOM_SIGNAL=bridge — REAL earbuds: a desktop machine runs
//                      bridge/desktop-bridge.js and streams its sidecar up
//                      here (requires FOCUSROOM_BRIDGE_TOKEN on both ends).
//                      No python runs on the web host at all in this mode.
const BRIDGE = process.env.FOCUSROOM_SIGNAL === 'bridge';
if (!BRIDGE) {
  process.env.FOCUSROOM_SIMULATE = process.env.FOCUSROOM_SIMULATE || '1';
  process.env.FOCUSROOM_PYTHON = process.env.FOCUSROOM_PYTHON || 'python3';
}

const config = require('./config');
const { createRoom } = require('./room-core');

const room = createRoom({});   // no windows: the TV shell follows session/state itself

async function start() {
  room.banner(BRIDGE ? 'WEB (headless · desktop bridge signal)' : 'WEB (headless)');
  console.log(`  tv        : /tv.html`);
  console.log(`  guest     : /ipad-flow.html?kiosk=1`);
  console.log(`  operator  : /ops.html`);
  if (BRIDGE) console.log(`  signal    : waiting for bridge/desktop-bridge.js to dial in`);
  console.log('');
  room.wireSidecar();
  room.wireSurfaces();
  room.startServerWithRetry();   // never rejects; retries if the port is busy
  await room.supervisor.start();
}

// a web host restarts the process itself — exit and let it, unless we're looping
room.attachCrashGuard((looping) => process.exit(looping ? 1 : 2));

const bye = () => room.cleanup().then(() => process.exit(0));
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

start().catch((e) => { console.error('[web] failed to start:', e); process.exit(1); });
