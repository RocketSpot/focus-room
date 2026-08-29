'use strict';
// Headless proof of the sim demo autopilot: patch setTimeout/clearTimeout with a
// virtual clock, drain one full loop instantly, assert the beat sequence + the
// sidecar commands + the cancel-on-real-input path.
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---- virtual clock (discrete-event) ----
let vnow = 0, id = 0;
const timers = new Map();
const realST = global.setTimeout, realCT = global.clearTimeout;
global.setTimeout = (fn, delay) => { id++; timers.set(id, { fire: vnow + (delay || 0), fn }); return id; };
global.clearTimeout = (h) => { timers.delete(h); };
function drain(maxSteps) {
  let n = 0;
  while (timers.size && n < maxSteps) {
    let best = null;
    for (const [h, t] of timers) if (!best || t.fire < best.t.fire) best = { h, t };
    timers.delete(best.h); vnow = best.t.fire; n++;
    try { best.t.fn(); } catch (e) { console.error('timer threw', e); }
    if (stopAfterIdle && beats.length >= 2 && beats[beats.length - 1] === 'idle'
        && beats.includes('close')) break;
  }
  return n;
}
let stopAfterIdle = false;

const { Orchestrator } = require(path.join(ROOT, 'app', 'orchestrator.js'));

let fail = 0;
const ok = (name, cond, d) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond ? '' : ' — ' + d}`); if (!cond) fail++; };

const sent = [];
const beats = [];
const supervisor = { send: (type, payload) => { sent.push({ type, payload }); return true; } };
const server = { broadcast: (type, payload) => { if (type === 'session/state') beats.push(payload.beat); } };
const orch = new Orchestrator({ supervisor, server, log: () => {} });

// ---- guards ----
orch.startDemo();
ok('startDemo is a no-op when demo not enabled', !orch._demoActive && beats.length === 0);
orch.enableDemo();
orch.startDemo();
ok('startDemo arms once enabled + idle', orch._demoActive === true);
const armed = timers.size;
orch.startDemo();
ok('startDemo is idempotent while active (no double-arm)', timers.size === armed, `${timers.size} vs ${armed}`);

// ---- drive one full loop ----
stopAfterIdle = true;
const fired = drain(400);
console.log(`\n  drained ${fired} timers; beat trace:\n   ${beats.join(' → ')}\n`);

const order = ['welcome', 'fit', 'intake', 'picker', 'reading', 'strongest', 'standby', 'email', 'close', 'idle'];
// the trace should contain the canonical order as a subsequence
let i = 0; for (const b of beats) if (b === order[i]) i++;
ok('beat trace walks welcome→fit→intake→picker→reading→strongest→standby→email→close→idle', i === order.length,
  `matched ${i}/${order.length}: ${beats.join(',')}`);

const st = sent.map((s) => (s.payload && s.payload.reason) ? `${s.type}:${s.payload.reason}` : s.type);
ok('fit streamed the signal check (connect + start_session:signal_check)',
  st.includes('connect') && st.includes('start_session:signal_check'), st.join(','));
ok('the signal check OPENED with the impedance phase (start_fit before the stream)',
  st.includes('start_fit') && st.indexOf('start_fit') < st.indexOf('start_session:signal_check'),
  st.join(','));
ok('reading opened its own stream (start_session:reading)', st.includes('start_session:reading'), st.join(','));
ok('signal check + reading were both stopped (stop_session present)', st.includes('stop_session'), st.join(','));

// ---- cancel on a real guest tap ----
const beats2 = [];
server.broadcast = (type, payload) => { if (type === 'session/state') beats2.push(payload.beat); };
orch.reset();                 // back to idle
orch.startDemo();
ok('re-armed for the cancel test', orch._demoActive === true);
// a REAL ipad guest event arrives (not from the demo) → autopilot yields
orch.onClientMessage({ type: 'guest/event', kind: 'earbud_seated', payload: {}, t: Date.now() }, 'ipad');
// The autopilot must yield, and the guest's own session must actually begin.
// (Don't assert timers===0: starting their session legitimately arms the
// abandonment watchdog, which shares the same patched clock.)
ok('a real guest tap cancels the autopilot', orch._demoActive === false, `active=${orch._demoActive}`);
ok('and the guest\'s own session starts', orch.beat === 'fit', `beat=${orch.beat}`);

global.setTimeout = realST; global.clearTimeout = realCT;
console.log(`\n${fail === 0 ? 'ALL GREEN' : fail + ' FAILURE(S)'}`);
process.exit(fail === 0 ? 0 : 1);
