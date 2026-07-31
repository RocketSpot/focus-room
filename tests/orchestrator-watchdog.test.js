'use strict';
// ============================================================
// tests/orchestrator-watchdog.test.js — the abandonment watchdog, the sidecar
// command re-issue, and the fit escalation, empirically.
// Plain node, no framework:  node tests/orchestrator-watchdog.test.js
// Exits non-zero on any failure.
//
// Requiring orchestrator.js here also proves it loads in plain node (no
// electron require, direct or transitive). The supervisor and server are
// stubbed to their real shapes: fire-and-forget send + broadcast-only.
// ============================================================
process.env.FOCUSROOM_FIT_HINT_MS = '80'; // parsed at module load — set before require

const path = require('path');
const { Orchestrator } = require(path.join(__dirname, '..', 'app', 'orchestrator.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stubs -------------------------------------------------------------------
const sent = [];   // every supervisor command (the spy)
const states = []; // every session/state broadcast (beat + notice)
const supervisor = { send: (type, payload) => { sent.push({ type, payload }); return true; } };
const server = { broadcast: (type, payload) => { if (type === 'session/state') states.push(payload); } };
const sentTypes = () => sent.map((s) => s.type);

const orch = new Orchestrator({ supervisor, server, log: () => {} });
const abandoned = [];
orch.on('event', (ev) => { if (ev.kind === 'session_abandoned') abandoned.push(ev); });

const hello = () => orch.onClientHello({ role: 'ipad', clientTime: Date.now() });
const guestEvent = (kind, payload) =>
  orch.onClientMessage({ type: 'guest/event', kind, payload, t: Date.now() }, 'ipad');
const intake = (fields) => orch.onClientMessage({ type: 'guest/intake', ...fields, t: Date.now() }, 'ipad');

(async () => {
  // ---- A1: the watchdog returns an abandoned session to idle -----------------
  console.log('\n-- abandonment watchdog --');
  hello();
  check('hello (ipad) at idle starts a fresh session', orch.beat === 'welcome');

  process.env.FOCUSROOM_IDLE_RESET_MS = '120'; // read at arm time — applies from the next (re)arm

  guestEvent('earbud_seated');
  check('earbud_seated advances to fit', orch.beat === 'fit');
  check('entering fit sends CONNECT + START_SESSION (signal check streams the waves)',
    sentTypes().includes('connect') && sentTypes().includes('start_session'), sentTypes().join(','));

  // messages keep arriving → the watchdog must NOT fire (each one re-arms it)
  for (let i = 0; i < 8; i++) { await sleep(50); guestEvent('reading_started'); } // no-op kind in fit; pure activity
  check('watchdog holds while messages keep arriving (~400ms > 120ms budget)', orch.beat === 'fit');

  // silence → expiry: stop what the beat had running, wipe state, back to idle
  orch.answers.onMind = 'the board deck'; // stand-in session state that must be wiped
  await sleep(400);
  check('watchdog fires after silence → beat back to idle', orch.beat === 'idle');
  check('expiry sent STOP_SESSION for the fit beat (streaming signal check)', sentTypes().includes('stop_session'), sentTypes().join(','));
  check('a session_abandoned diag event was emitted',
    abandoned.length === 1 && abandoned[0].payload && abandoned[0].payload.beat === 'fit');
  check('session state was cleared',
    orch.answers.onMind === '' && orch.reveal === null && orch.revealStep === 0
    && orch.signalIssue === false && orch.events.length === 0);
  const idleState = states[states.length - 1];
  check('idle state was broadcast (TV → constellation)',
    idleState && idleState.beat === 'idle' && idleState.surface === 'constellation');

  delete process.env.FOCUSROOM_IDLE_RESET_MS; // budgets back to real scale for the rest

  hello();
  check('a second hello starts a fresh session', orch.beat === 'welcome' && orch.events.length === 0);

  // ---- A2: sidecar restart re-issues the beat's commands ---------------------
  console.log('\n-- sidecar command re-issue --');
  sent.length = 0;
  orch.onSidecarReady();
  check('onSidecarReady at welcome sends nothing', sent.length === 0, sentTypes().join(','));

  guestEvent('earbud_seated'); // welcome → fit
  sent.length = 0;
  orch.onSidecarReady();
  check('onSidecarReady at fit re-sends CONNECT then START_SESSION',
    sentTypes()[0] === 'connect' && sentTypes()[1] === 'start_session', sentTypes().join(','));
  check('a fit restart does not set signalIssue', orch.signalIssue === false);

  // ---- A3: the signal check SETTLES, it does not gate -------------------------
  // The room never waits on signal quality and never narrates the signal to a guest.
  // After a short settle it is simply ready, and no coaching notice is ever broadcast.
  console.log('\n-- signal check settles (never gated, never narrated) --');
  await sleep(160); // > the 80ms settle window; NO signal information has arrived
  let last = states[states.length - 1];
  check('the settle makes the room ready with no signal at all',
    orch.beat === 'fit' && orch._fitAllGood === true && last && last.fitAllGood === true, JSON.stringify(last));
  check('no guest-facing coaching notice is ever broadcast', last && last.notice === null, JSON.stringify(last));
  check('_notice() is null even with the stream down + reseat active',
    (() => { orch._eegDown = true; orch._reseatActive = true; orch._fitSlow = true;
      const n = orch._notice(); orch._eegDown = false; orch._reseatActive = false; orch._fitSlow = false; return n === null; })());

  // ---- A2 (reading): re-issue START_SESSION + sticky signalIssue -------------
  console.log('\n-- sidecar re-issue during reading --');
  guestEvent('fit_confirmed');                                     // fit → intake
  intake({ answers: { 0: 'A blip — I barely notice' }, onMind: 'the board deck' }); // intake → picker
  intake({ reading: { id: 'octopus', title: 'How an Octopus Thinks' } });           // picker → reading
  check('flow reaches reading', orch.beat === 'reading');
  sent.length = 0;
  orch.onSidecarReady();
  check('onSidecarReady at reading re-sends START_SESSION', sentTypes().includes('start_session'), sentTypes().join(','));
  check('a reading restart sets the sticky signalIssue flag', orch.signalIssue === true);

  // ---- summary ----------------------------------------------------------------
  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
