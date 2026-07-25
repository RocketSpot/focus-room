'use strict';
// ============================================================
// tests/link-resilience.test.js — a dropped link must PAUSE, never decide.
//
// The room runs unattended with a guest sitting in it wearing the buds. Wi-Fi
// and Bluetooth both drop in real rooms, and when they do nothing may cancel
// the session, restart a beat, reset the flow, or throw away recorded EEG.
// Every check here is a way the room used to (or could) break that promise.
//
//   node tests/link-resilience.test.js
// ============================================================
process.env.FOCUSROOM_EEG_STALL_MS = '120';   // parsed at module load
process.env.FOCUSROOM_LINK_LOST_MS = '600';   // a short "nothing came back" ceiling

const path = require('path');
const { Orchestrator } = require(path.join(__dirname, '..', 'app', 'orchestrator.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stubs ----------------------------------------------------------------
const sent = [];
const states = [];
const supervisor = { send: (type, payload) => { sent.push({ type, payload }); return true; } };
// presence is switchable, which is the whole point: the orchestrator has to be
// able to tell "the guest walked out" from "the iPad fell off the Wi-Fi"
let ipadPresent = true;
const server = {
  broadcast: (type, payload) => { if (type === 'session/state') states.push(payload); },
  hasRole: (role) => (role === 'ipad' ? ipadPresent : true),
};
const sentTypes = () => sent.map((s) => s.type);

function newOrch() {
  const o = new Orchestrator({ supervisor, server, log: () => {} });
  return o;
}
const hello = (o) => o.onClientHello({ role: 'ipad', clientTime: Date.now() });
const guestEvent = (o, kind, payload) =>
  o.onClientMessage({ type: 'guest/event', kind, payload, t: Date.now() }, 'ipad');
const intake = (o, fields) => o.onClientMessage({ type: 'guest/intake', ...fields, t: Date.now() }, 'ipad');

// walk a fresh orchestrator to the reading beat
function toReading(o) {
  hello(o);
  guestEvent(o, 'earbud_seated');
  guestEvent(o, 'fit_confirmed');
  intake(o, { answers: { 0: 'A blip, I barely notice' }, onMind: 'the board deck' });
  intake(o, { reading: { id: 'octopus', title: 'How an Octopus Thinks' } });
}
// a frame as the sidecar sends it
const frame = (o, tRel, v) => o.onSidecar({
  type: 'eeg/frame', tRel, t: Date.now(), engagementRel: v == null ? 0.6 : v, signalQuality: 0.9,
});

(async () => {
  // ---- 1. A Wi-Fi drop must not abandon a live session ---------------------
  console.log('\n-- Wi-Fi: an unreachable guest is not an absent guest --');
  {
    const o = newOrch();
    ipadPresent = true;
    toReading(o);
    o.answers.onMind = 'the board deck';
    check('flow reaches reading', o.beat === 'reading');

    process.env.FOCUSROOM_IDLE_RESET_MS = '100';
    // the iPad drops off the network, then the budget elapses several times over
    ipadPresent = false;
    o.onClientLeft('ipad');
    o._armWatchdog();
    await sleep(450);

    check('the session is STILL alive after the budget elapsed while unreachable',
      o.beat === 'reading', `beat=${o.beat}`);
    check('the guest\'s answers were not wiped', o.answers.onMind === 'the board deck');
    check('the room did not fall back to idle', o.beat !== 'idle');

    // the iPad comes back — the session simply continues
    ipadPresent = true;
    o.onClientRejoined('ipad');
    check('reconnecting keeps the same beat, it does not restart the flow', o.beat === 'reading');
    check('the reconnect is recorded for the diagnostic trail',
      o.events.some((e) => e.kind === 'link_restored'));
    delete process.env.FOCUSROOM_IDLE_RESET_MS;
    o.reset();
  }

  // ---- 2. But a genuinely absent, REACHABLE guest is still reclaimed -------
  console.log('\n-- the watchdog still works when the guest really is reachable --');
  {
    const o = newOrch();
    ipadPresent = true;
    hello(o);
    guestEvent(o, 'earbud_seated');
    process.env.FOCUSROOM_IDLE_RESET_MS = '100';
    o._armWatchdog();
    await sleep(300);
    check('a reachable but silent guest is still abandoned', o.beat === 'idle', `beat=${o.beat}`);
    delete process.env.FOCUSROOM_IDLE_RESET_MS;
    o.reset();
  }

  // ---- 3. ...and an outage that never ends eventually frees the room -------
  console.log('\n-- the ceiling: a link that never returns must not wedge the room --');
  {
    const o = newOrch();
    ipadPresent = true;
    toReading(o);
    process.env.FOCUSROOM_IDLE_RESET_MS = '100';
    ipadPresent = false;
    o.onClientLeft('ipad');
    o._linkLostAt = Date.now() - 5000;   // backdate PAST the ceiling (onClientLeft stamps it fresh)
    o._armWatchdog();
    await sleep(300);
    check('past the ceiling the room reclaims itself', o.beat === 'idle', `beat=${o.beat}`);
    delete process.env.FOCUSROOM_IDLE_RESET_MS;
    ipadPresent = true;
    o.reset();
  }

  // ---- 4. Bluetooth: silence is noticed, held, and recorded as a gap -------
  console.log('\n-- Bluetooth: the stream going quiet holds the session --');
  {
    const o = newOrch();
    ipadPresent = true;
    toReading(o);
    for (let i = 0; i < 4; i++) frame(o, i, 0.6);
    check('a live stream reports link.eeg = live', o._linkState().eeg === 'live');

    await sleep(300);   // > EEG_STALL_MS with no frames at all
    check('the stall is detected', o._eegDown === true);
    check('the beat did NOT change when the stream died', o.beat === 'reading', `beat=${o.beat}`);
    check('the guest-facing notice is the calm signal_lost', o._notice() === 'signal_lost');
    check('link state reads holding, not failed', o._linkState().eeg === 'holding');
    check('the session is flagged so the reveal leans on clean stretches', o.signalIssue === true);

    // the buds come back
    frame(o, 10, 0.6);
    check('a returning frame clears the hold', o._eegDown === false);
    check('the notice clears with it', o._notice() === null);
    check('the dropout was recorded as a gap', o._streamGaps.length === 1,
      JSON.stringify(o._streamGaps));
    check('the gap reaches the reveal so the chart can break its lines',
      (o.revealPayload().gaps || []).length === 1);
    o.reset();
  }

  // ---- 5. The session clock must not run backwards across a restart -------
  console.log('\n-- the stream clock stays monotonic across a sidecar restart --');
  {
    const o = newOrch();
    ipadPresent = true;
    toReading(o);
    for (let i = 0; i <= 10; i++) frame(o, i, 0.6);
    const beforeMax = o._streamT();
    check('the clock advanced with the stream', beforeMax >= 10, `t=${beforeMax}`);

    // the sidecar dies and comes back; its tRel reopens at zero
    o.onSidecarReady();
    for (let i = 0; i <= 5; i++) frame(o, i, 0.6);

    const ts = (o.streamLog.frames || []).map((f) => f.t);
    let monotonic = true;
    for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1]) monotonic = false;
    check('no recorded frame time ever goes backwards', monotonic,
      JSON.stringify(ts.slice(-8)));
    check('the post-restart stream continues past the pre-restart clock',
      ts[ts.length - 1] > beforeMax, `last=${ts[ts.length - 1]} vs ${beforeMax}`);
    o.reset();
  }

  // ---- 6. Never spend the interruption while we cannot measure it ----------
  console.log('\n-- the interruption waits for a signal to measure it against --');
  {
    const o = newOrch();
    ipadPresent = true;
    toReading(o);
    for (let i = 0; i < 3; i++) frame(o, i, 0.6);
    await sleep(300);            // let the stream stall
    check('precondition: the stream is down', o._eegDown === true);

    const before = sentTypes().filter((t) => t === 'mark').length;
    o.onSidecar({ type: 'session/plateau', t: Date.now() });
    check('a plateau during a dropout does NOT fire the interruption',
      o.interruptionFired === false);
    check('and no mark was sent to the sidecar',
      sentTypes().filter((t) => t === 'mark').length === before);

    frame(o, 20, 0.6);           // signal returns
    o.onSidecar({ type: 'session/plateau', t: Date.now() });
    check('once the signal is back the interruption fires normally',
      o.interruptionFired === true);
    o.reset();
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
