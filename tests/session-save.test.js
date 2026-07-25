'use strict';
// ============================================================
// tests/session-save.test.js — the FULL session is recorded and written to disk,
// not just the constellation dot. Plain node:  node tests/session-save.test.js
// Exits non-zero on any failure.
//
// Drives a whole session through the real Orchestrator (stubbed supervisor +
// server), feeds a live FRAME/BRAINWAVES/METRICS stream + session samples +
// archetype, then checks the emitted record — and actually round-trips it through
// store.saveSession() to a file and reads it back.
// ============================================================
const path = require('path');
const fs = require('fs');
const os = require('os');

// store.js → config.js → require('electron'); stub it so store loads in plain node.
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: () => os.tmpdir() } } };

const { Orchestrator } = require(path.join(__dirname, '..', 'app', 'orchestrator.js'));
const { Store } = require(path.join(__dirname, '..', 'app', 'store.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---- stubs (real shapes) ----
const supervisor = { send: () => true };
const server = { broadcast: () => {} };
const orch = new Orchestrator({ supervisor, server, log: () => {} });
const records = [];
orch.on('session-record', (r) => records.push(JSON.parse(JSON.stringify(r)))); // snapshot each save

const hello = () => orch.onClientHello({ role: 'ipad', clientTime: Date.now() });
const ev = (kind, payload) => orch.onClientMessage({ type: 'guest/event', kind, payload, t: Date.now() }, 'ipad');
const intake = (fields) => orch.onClientMessage({ type: 'guest/intake', ...fields, t: Date.now() }, 'ipad');
const sc = (msg) => orch.onSidecar(msg);

(function run() {
  // walk to the reading
  hello();                                   // → welcome
  ev('earbud_seated');                       // → fit
  ev('fit_confirmed');                       // → intake
  intake({ answers: { 0: 'A blip — I barely notice', 1: 'It drifts here and there', 2: 'It takes me a few minutes' }, onMind: 'a deadline on Friday' }); // → picker
  intake({ reading: { id: 'octopus', title: 'How an Octopus Thinks', meta: '3 min · Science' } });      // → reading (recording opens)

  check('session id opened at reading', orch.sessionId != null);

  // feed a live stream during the reading
  const base = Date.now();
  for (let i = 0; i < 32; i++) {
    const v = Math.max(0.05, Math.min(0.95, 0.12 + (i / 31) * 0.7 - (i > 18 && i < 24 ? 0.3 : 0)));
    sc({ type: 'eeg/frame', tRel: i, t: base + i * 1000, engagementRel: v, stateWord: v > 0.6 ? 'focused' : 'settling' });
    sc({ type: 'eeg/brainwaves', delta: 0.3 - v * 0.1, theta: 0.4 - v * 0.15, alpha: 0.6 - v * 0.4, beta: 0.15 + v * 0.7, gamma: 0.1 + v * 0.5, engIndex: v * 1.4 });
    sc({ type: 'eeg/metrics', engagement: v, focus: v * 0.95, stress: 0.2, mental_readiness: 0.6, drowsiness: 0.1, relaxation: 0.5, wellness: 0.6 });
  }
  // the sidecar's end-of-session emits (STOP_SESSION → these)
  const samples = [];
  for (let i = 0; i < 40; i++) { const v = 0.1 + (i / 39) * 0.75; samples.push({ t: i * 1.02, v: +v.toFixed(3), vr: +(v * 0.9).toFixed(3) }); }
  sc({ type: 'session/samples', samples });
  sc({ type: 'session/archetype', label: 'deep', name: 'Deep Diver', settle: 'slowly', variability: 'variable' });

  ev('reading_finished');                    // → strongest
  ev('strongest_stretch_guess', { choice: 'near the end' });  // → reveal → SAVE #1
  ev('reveal_ack');                          // standby → email
  ev('email_entered', { email: '  Guest@Example.com ' });     // → SAVE #2 (email)
  ev('close_choice', { door: 'customer' });                   // → SAVE #3 (final)

  // ---- assertions on the final record ----
  check('a session record was emitted', records.length >= 1, `got ${records.length}`);
  const rec = records[records.length - 1];
  check('has a stable id + startedAt', rec.id != null && rec.startedAt != null);
  check('focus line saved', Array.isArray(rec.focusLine) && rec.focusLine.length === 40, `len ${rec.focusLine && rec.focusLine.length}`);
  check('live frames captured', rec.stream && rec.stream.frames.length === 32, `frames ${rec.stream && rec.stream.frames.length}`);
  check('live band stream captured', rec.stream && rec.stream.bands.length === 32 && rec.stream.bands[0].beta != null, `bands ${rec.stream && rec.stream.bands.length}`);
  check('live metric stream captured', rec.stream && rec.stream.metrics.length === 32 && rec.stream.metrics[0].focus != null);
  check('four reads saved', rec.reads && Object.keys(rec.reads).length >= 1);
  check('archetype + features saved', rec.archetype && rec.archetype.label && rec.archetypeFeatures);
  check('intake answers saved', rec.intake && rec.intake['0']);
  check('on-mind text saved', rec.onMind === 'a deadline on Friday');
  check('reading choice saved', rec.reading && rec.reading.id === 'octopus');
  check('strongest guess saved', rec.strongestGuess === 'near the end');
  check('email captured in final record', rec.email === '  Guest@Example.com ');
  check('door captured in final record', rec.closeDoor === 'customer');
  check('re-saved in place (same id, 3 saves)', records.length === 3 && records[0].id === records[2].id, `saves ${records.length}`);

  // ---- round-trip through the real store to a file ----
  const store = new Store();
  const file = store.saveSession(rec);
  check('store wrote a file', !!file && fs.existsSync(file), file || 'no path');
  let readBack = null;
  try { readBack = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* handled by check */ }
  check('file is valid JSON with the full record', readBack && readBack.id === rec.id && readBack.stream.bands.length === 32 && readBack.reading.id === 'octopus');
  if (file && fs.existsSync(file)) fs.unlinkSync(file); // clean up the test artifact

  console.log(failures ? `\n${failures} FAILED` : '\nALL GREEN');
  process.exit(failures ? 1 : 0);
})();
