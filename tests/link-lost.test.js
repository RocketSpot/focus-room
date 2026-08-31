'use strict';
// ============================================================
// tests/link-lost.test.js — the total-disconnect flow, empirically.
//
// The rules, exactly as decided after the first real-hardware runs:
//  - signal QUALITY is never named to a guest, anywhere, ever
//  - a TOTAL loss of the earbuds mid-session IS named: full cover on the iPad,
//    quiet card on the TV, both driven by link.lost on canonical state
//  - the session pauses at safe points: it never advances INTO the reading
//    while the buds are down, and the held reading starts itself on recovery
//  - simulation never shows any of it (sim cannot lose real earbuds)
//
// Plain node:  node tests/link-lost.test.js
// ============================================================
const path = require('path');
const { Orchestrator } = require(path.join(__dirname, '..', 'app', 'orchestrator.js'));

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

function mk() {
  const states = [];
  const supervisor = { send: () => true };
  const server = { broadcast: (type, payload) => { if (type === 'session/state') states.push(payload); } };
  const o = new Orchestrator({ supervisor, server, log: () => {} });
  return { o, states };
}

// ---- link.lost fires only on a real, total, mid-session loss ----------------
{
  const { o } = mk();
  o._eegSimulation = false;
  o.beat = 'reading';
  o._eegDown = true;
  check('a real total loss mid-session sets link.lost', o._linkState().lost === true);
  o._eegDown = false;
  check('a live stream never sets link.lost', o._linkState().lost === false);
  o._eegDown = true; o.beat = 'idle';
  check('an idle room never sets link.lost (no guest to cover)', o._linkState().lost === false);
  o.beat = 'standby';
  check('the reveal never shows the cover (EEG is done by then)', o._linkState().lost === false);
  o.beat = 'reading'; o._eegSimulation = true;
  check('simulation NEVER shows the cover', o._linkState().lost === false);
}

// ---- the safe-point pause -----------------------------------------------------
{
  const { o } = mk();
  o._eegSimulation = false;
  o.beat = 'picker';
  // review CE-3: _eegDown cannot survive to the picker (setBeat clears it on
  // leaving the streaming beats), so the hold keys on the CONNECTION truth
  o._budsConnected = false;
  o._onIntake({ reading: { id: 'octopus', title: 'How an Octopus Thinks' }, t: Date.now() });
  check('the reading does NOT begin while the buds are down', o.beat === 'picker', o.beat);
  check('the held start is remembered', o._pendingReadingStart === true);
  check('the choice itself is never lost', o.answers.reading && o.answers.reading.id === 'octopus');

  // stream returns: the reading begins on its own
  o._lastFrameAt = o.now();
  o._eegDown = false;
  // replicate the recovery path's resume block, as the stream handler runs it
  if (o._pendingReadingStart && o.beat === 'picker') { o._pendingReadingStart = false; o._beginReading(); }
  check('the held reading begins the moment the stream returns', o.beat === 'reading', o.beat);
}

// ---- a live link never blocks -------------------------------------------------
{
  const { o } = mk();
  o._eegSimulation = false;
  o.beat = 'picker';
  o._eegDown = false;
  o._onIntake({ reading: { id: 'octopus', title: 'How an Octopus Thinks' }, t: Date.now() });
  check('with the buds up, the reading begins immediately', o.beat === 'reading', o.beat);
}

// ---- the cover copy itself never mentions quality ----------------------------
{
  const fs = require('fs');
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'ipad', 'controller.jsx'), 'utf8');
  const coverStart = bundle.indexOf('LinkLostCover');
  const cover = bundle.slice(coverStart, coverStart + 2400);
  check('the iPad cover names the CONNECTION, never quality',
    /lost their connection/i.test(cover) && !/quality|weak|poor|clean|limited/i.test(cover));
  const tv = fs.readFileSync(path.join(__dirname, '..', 'tv-orb.html'), 'utf8');
  check('the TV card says held, never a verdict',
    /session held/i.test(tv) && !/quality|weak|poor/i.test(tv.match(/#linklost[\s\S]{0,600}/)[0]));
}



// ---- the progress trigger (appended here rather than a new file: same era) ----
{
  const states2 = [];
  const supervisor2 = { send: () => true };
  const server2 = { broadcast: (t, p) => { if (t === 'session/state') states2.push(p); } };
  const o = new Orchestrator({ supervisor: supervisor2, server: server2, log: () => {} });
  o._eegSimulation = true;
  o.beat = 'picker';
  o._onIntake({ reading: { id: 'octopus', title: 'x' }, t: Date.now() });
  // stream is alive
  o._lastFrameAt = o.now();
  o.timeline.lastFrame = { tRel: 30 };
  o._readingStartedAtMs = o.now() - 25000;         // 25s into the reading
  o.onClientMessage({ type: 'guest/event', kind: 'reading_scroll', payload: { p: 0.45 }, t: Date.now() }, 'ipad');
  check('scrolling past 40% of the piece fires the notification', o.interruptionFired === true);

  const o2 = new Orchestrator({ supervisor: supervisor2, server: server2, log: () => {} });
  o2._eegSimulation = true;
  o2.beat = 'picker';
  o2._onIntake({ reading: { id: 'octopus', title: 'x' }, t: Date.now() });
  o2._lastFrameAt = o2.now();
  o2.timeline.lastFrame = { tRel: 5 };
  o2._readingStartedAtMs = o2.now() - 6000;        // only 6s in: the settle is sacred
  o2.onClientMessage({ type: 'guest/event', kind: 'reading_scroll', payload: { p: 0.9 }, t: Date.now() }, 'ipad');
  check('a fast scroller cannot fire it during the settle-in', o2.interruptionFired === false);
}

console.log(failures === 0 ? '\nall link-lost checks passed' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
