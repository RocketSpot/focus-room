'use strict';
// ============================================================
// ONE reading clock, anchored where the guest's reading starts.
// ------------------------------------------------------------
// Forensics on the 2026-08-31 session: the epoch anchored at the FIRST EEG
// frame, 11.58s of SDK warm-up after reading_started, so the notification was
// recorded at 49.88s when the guest experienced it 61.46s in; _streamT()
// returned the frozen last-frame clock, so fourteen seconds of scroll taps
// collapsed onto one instant and the track ran backwards when the frame clock
// re-zeroed; and a no-signal tail measured zero seconds (from == to) and was
// discarded. Every check replays a shape from that trail.
//   node tests/reading-clock.test.js
// ============================================================
const path = require('path');
const { Orchestrator } = require(path.join(__dirname, '..', 'app', 'orchestrator.js'));

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.error(' FAIL  ' + name + (detail ? ' >> ' + detail : '')); }
};
const mk = () => new Orchestrator({
  supervisor: { send: () => true }, server: { broadcast: () => {} }, log: () => {},
});
const T0 = 1788187319713;   // the real session's reading_started master time

function toReading(o, vnowRef) {
  o.now = () => vnowRef.t;
  o._budsConnected = true;
  o.beat = 'picker';
  o.answers.intake = {};
  o._onIntake({ reading: { id: 'x', title: 'X' }, t: vnowRef.t });
}

// ---- the 11.58s warm-up no longer shifts the guest's clock ----
{
  const v = { t: T0 };
  const o = mk();
  toReading(o, v);
  // SDK warm-up: the first frame lands 11.58s later carrying tRel 0
  v.t = T0 + 11580;
  o.onSidecar({ type: 'eeg/frame', tRel: 0, t: v.t, engagementRel: 0.5, signalQuality: 0.9 });
  const f0 = o.streamLog.frames[0];
  check('the first frame is recorded at ~11.6s, not silently relabeled t=0',
    Math.abs(f0.t - 11.58) < 0.05, JSON.stringify(f0));
  // the interruption fires at the real 61.46s mark
  v.t = T0 + 61460;
  o._fireInterruption();
  check('the notification is stamped where the guest experienced it (61.5s, not 49.9s)',
    Math.abs(o.interruptEegT - 61.46) < 0.1, String(o.interruptEegT));
  o._clearSession();
}

// ---- scroll taps during a dropout keep their own moments ----
{
  const v = { t: T0 };
  const o = mk();
  toReading(o, v);
  v.t = T0 + 12000;
  o.onSidecar({ type: 'eeg/frame', tRel: 0, t: v.t, engagementRel: 0.5, signalQuality: 0.9 });
  const scroll = (p) => o._onGuestEvent({ kind: 'reading_scroll', payload: { p }, t: v.t });
  scroll(0.10);
  // fourteen seconds pass with NO frames (the drift-rejection stretch); each
  // tap must land at its own second, not pile onto the gap's left edge
  for (let i = 1; i <= 4; i++) { v.t += 3500; scroll(0.10 + i * 0.05); }
  const ts = o.scrollTrack.map((s) => s.t);
  const distinct = new Set(ts.map((t) => Math.round(t)));
  check('scroll taps during frame silence keep distinct times',
    distinct.size >= 4, JSON.stringify(ts));
  let mono = true;
  for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1] - 0.01) mono = false;
  check('the scroll track never runs backwards', mono, JSON.stringify(ts));
  o._clearSession();
}

// ---- the gap ledger is rebuilt from the frames themselves ----
{
  const v = { t: T0 };
  const o = mk();
  toReading(o, v);
  const at = (sec, tRel) => { v.t = T0 + sec * 1000;
    o.onSidecar({ type: 'eeg/frame', tRel, t: v.t, engagementRel: 0.5, signalQuality: 0.9 }); };
  at(12, 0); at(13, 1); at(14, 2);
  // the 6.03s hole the live detector missed (frames 76.3 -> 82.3 in the trail)
  at(20.1, 3);
  at(21, 4);
  // the reading ends 8s after the last frame: the discarded tail
  v.t = T0 + 29000;
  o._onGuestEvent({ kind: 'reading_finished', t: v.t });
  const gaps = o._reconciledGaps();
  const covers = (a, b) => gaps.some((g) => g.from <= a + 0.6 && g.to >= b - 0.6);
  check('the head warm-up is a visible hole, not a relabeled zero', covers(0, 12), JSON.stringify(gaps));
  check('a mid-reading hole is in the ledger even if live detection missed it',
    covers(14, 20.1), JSON.stringify(gaps));
  check('the no-signal tail is in the ledger (it used to measure zero and vanish)',
    covers(21, 29), JSON.stringify(gaps));
  o._clearSession();
}

// ---- post-reading taps are not brain coordinates ----
{
  const v = { t: T0 };
  const o = mk();
  toReading(o, v);
  v.t = T0 + 12000;
  o.onSidecar({ type: 'eeg/frame', tRel: 0, t: v.t, engagementRel: 0.5, signalQuality: 0.9 });
  v.t = T0 + 99000;
  o._onGuestEvent({ kind: 'reading_finished', t: v.t });
  v.t = T0 + 194000;
  check('an email-time tap no longer carries a reading eegT (was 194.68 in the record)',
    o._readingEegTimeOf(v.t) === null, String(o._readingEegTimeOf(v.t)));
  check('a mid-reading moment still maps', Math.abs(o._readingEegTimeOf(T0 + 50000) - 50) < 0.1);
  o._clearSession();
}

console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'ALL GREEN'));
process.exit(failures ? 1 : 0);
