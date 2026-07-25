'use strict';
// ============================================================
// desktop-bridge.js — the earbuds' side of the split room.
// ------------------------------------------------------------
// Runs on the machine PHYSICALLY NEXT TO the Zone earbuds. Spawns the real
// sidecar exactly like the room app does (Zone SDK, Bluetooth, the whole
// signal engine), and forwards its NDJSON stream up to a web-hosted room
// (Replit) over the room's own WebSocket, as role 'bridge'. Commands from
// the room (start_fit, start_session, mark…) flow back down the same pipe.
//
//   node bridge/desktop-bridge.js
//     env FOCUSROOM_ROOM_URL     e.g. https://your-room.replit.app  (or ws[s]://…/ws)
//     env FOCUSROOM_BRIDGE_TOKEN the same secret the room was deployed with
//     --simulate                 use the sim source instead of real buds
//                                (plumbing test only — the room's badge will
//                                say SIMULATION, honestly)
//
// The room treats a dropped bridge as a PAUSE (stall detector), so a Wi-Fi
// blip here never cancels a session. This script reconnects forever.
// ============================================================
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));   // repo root: config resolves the sidecar

const WebSocket = require('ws');
const config = require('../app/config');
const { SidecarSupervisor } = require('../app/sidecar-supervisor');

const RAW_URL = process.env.FOCUSROOM_ROOM_URL || process.argv.find((a) => a.startsWith('http') || a.startsWith('ws'));
const TOKEN = process.env.FOCUSROOM_BRIDGE_TOKEN;
if (!RAW_URL || !TOKEN) {
  console.error('usage: FOCUSROOM_ROOM_URL=https://your-room.replit.app FOCUSROOM_BRIDGE_TOKEN=<secret> node bridge/desktop-bridge.js [--simulate]');
  process.exit(1);
}
const WS_URL = RAW_URL.replace(/^http/, 'ws').replace(/\/+$/, '').replace(/\/ws$/, '') + '/ws';

console.log('─'.repeat(54));
console.log('  ZONE — THE FOCUS ROOM · desktop signal bridge');
console.log(`  room      : ${WS_URL}`);
console.log(`  signal    : ${config.SIMULATE ? '*** SIMULATION (plumbing test) ***' : 'REAL EEG (Zone earbuds)'}`);
console.log('─'.repeat(54));

const supervisor = new SidecarSupervisor();
let ws = null, up = false, attempt = 0;

function send(o) { if (ws && up) { try { ws.send(JSON.stringify(o)); } catch (e) {} } }

supervisor.on('message', (msg) => send({ type: 'bridge/out', msg }));
supervisor.on('stderr', (line) => console.log('[sidecar]', String(line).trim()));
supervisor.on('exit', (info) => console.log('[sidecar] exited', info, '— supervisor restarts it'));

function connect() {
  ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    up = true; attempt = 0;
    console.log('[bridge] connected to the room');
    send({ type: 'client/hello', role: 'bridge', t: Date.now() });
    send({ type: 'bridge/hello', token: TOKEN, info: supervisor.info, t: Date.now() });
    // the room missed the sidecar's boot one-shots — replay what matters
    if (supervisor.info && supervisor.info.ready) {
      send({ type: 'bridge/out', msg: { type: 'ready', replay: true } });
    }
  });
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (m.type === 'bridge/accepted') console.log('[bridge] room accepted the token — streaming');
    if (m.type === 'bridge/cmd' && m.cmd) {
      const ok = supervisor.send(m.cmd, m.payload || {});
      if (!ok) console.log(`[bridge] room command ${m.cmd} could not reach the sidecar`);
    }
  });
  const down = () => {
    if (up) console.log('[bridge] link to the room dropped — reconnecting (the room pauses, nothing is lost)');
    up = false;
    const base = Math.min(8000, 500 * Math.pow(2, Math.min(attempt++, 4)));
    setTimeout(connect, base + Math.random() * base * 0.4);
  };
  ws.on('close', down);
  ws.on('error', (e) => { try { ws.close(); } catch (_) {} });
}

(async () => {
  await supervisor.start();
  connect();
})();

process.on('SIGINT', async () => { try { await supervisor.stop(); } catch (e) {} process.exit(0); });
