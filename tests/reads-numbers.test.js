'use strict';
// The reveal now puts NUMBERS on the wall, so the guards that keep those
// numbers honest need their own regression net. Everything here is a claim the
// room made (or nearly made) on a real recording at some point.
const assert = require('assert');
const { computeReads } = require('../app/reads.js');

let pass = 0;
const ok = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

// ---- fixtures -------------------------------------------------------------
// a session that settles, dips hard at the notification, then recovers
function dippy() {
  const samples = [], bands = [];
  for (let i = 0; i <= 180; i++) {
    const t = i, f = i / 180;
    let v = 0.1 + 0.75 / (1 + Math.exp(-(f - 0.15) * 18));
    v -= Math.exp(-((f - 0.5) ** 2) / (2 * 0.035 ** 2)) * 0.55;   // the dip
    v = Math.max(0.02, Math.min(1, v));
    samples.push({ t, v, vr: v });
    // The focus line is derived from the BANDS now, so the dip has to live here:
    // starting AT the notification (f=0.5) and recovering, the way a real one
    // does — beta drops, alpha/theta rise, so EI = beta/(alpha+theta) dips.
    const d = f - 0.5;
    const dip = d >= 0 ? Math.exp(-(d ** 2) / (2 * 0.05 ** 2)) : 0;
    bands.push({ t, delta: 0.30, theta: 0.22 + dip * 0.06, alpha: 0.16 + dip * 0.08,
      beta: 0.28 - dip * 0.16, gamma: 0.004 });
  }
  return { samples, bands };
}
// a session where nothing moved at the notification
function flatline() {
  const samples = [], bands = [];
  for (let i = 0; i <= 180; i++) {
    const v = 0.5 + 0.004 * Math.sin(i / 7);
    samples.push({ t: i, v, vr: v });
    bands.push({ t: i, delta: 0.30, theta: 0.25, alpha: 0.20, beta: 0.24, gamma: 0.004 });
  }
  return { samples, bands };
}
// a drift-heavy read where one band holds almost all the power and a tiny band
// swings wildly — this is what produced "beta ran 393% above its session level"
function driftHeavy() {
  const samples = [], bands = [];
  for (let i = 0; i <= 180; i++) {
    const v = 0.4 + 0.2 * Math.sin(i / 30);
    samples.push({ t: i, v, vr: v });
    const late = i > 120 ? 6 : 1;                        // tiny band, huge swing
    bands.push({ t: i, delta: 0.85, theta: 0.10, alpha: 0.02, beta: 0.005 * late, gamma: 0.001 });
  }
  return { samples, bands };
}

// a session whose strongest stretch is the very OPENING — engagement peaks at
// t=0 and decays. This is real (session-1784685149031 did it) and it exposed
// the clock floor: round5's 5-second minimum turned 0:00 into 0:05, producing
// "your strongest 10 sec ran from 0:05 to 0:10" on the wall.
function openingPeak() {
  const samples = [], bands = [];
  for (let i = 0; i <= 96; i++) {
    const t = i, f = i / 96;
    const beta = 0.06 + 0.24 * Math.exp(-f / 0.12);       // hot start, fast decay
    const v = 0.2 + 0.7 * Math.exp(-f / 0.12);
    samples.push({ t, v, vr: v });
    bands.push({ t, delta: 0.45, theta: 0.18 + 0.12 * f, alpha: 0.14, beta, gamma: 0.004 });
  }
  return { samples, bands };
}

const run = (fx, answers) => computeReads({
  samples: fx.samples, bands: fx.bands, answers: answers || {}, interruptEegT: 90, signalIssue: false,
});

const clockToSec = (c) => { const [m, s] = c.split(':').map(Number); return m * 60 + s; };
const durToSec = (d) => {
  const m = d.match(/^(?:(\d+) min)?\s*(?:(\d+) sec)?$/);
  return (parseInt(m[1] || 0, 10)) * 60 + parseInt(m[2] || 0, 10);
};

const allText = (r) => r.reads.map((x) =>
  [x.sentence, x.bandNote, x.stat && x.stat.value, x.stat && x.stat.label,
    x.ledger && x.ledger.did].filter(Boolean).join(' ')).join(' \n ');

console.log('\n-- reveal numbers: the honesty guards --');

ok('a real dip reports a recovery time', () => {
  const r = run(dippy());
  assert.strictEqual(r.stats.realDip, true, 'expected a measurable dip');
  assert.ok(r.stats.recoverSec > 0, 'recoverSec should be positive');
  assert.ok(/to get back to where you were/.test(r.reads[2].stat.label), r.reads[2].stat.label);
});

ok('no dip means NO invented recovery time', () => {
  const r = run(flatline());
  assert.strictEqual(r.stats.realDip, false, 'flat session should not register a dip');
  assert.strictEqual(r.stats.recoverSec, null, 'recoverSec must be null, not 0 or the 5s rounding floor');
  // truly-flat interruption: no focus dip AND no band shift → "Held", never a number
  assert.strictEqual(r.reads[2].stat.value, 'Held', r.reads[2].stat.value);
  // the old copy read "fell 0% of its own range and needed 5 sec to return"
  const t = allText(r);
  assert.ok(!/fell 0%/.test(t), 'must not report a 0% fall as a finding: ' + t);
  assert.ok(!/needed 5 sec|back inside 5 sec/.test(t), 'must not invent a recovery: ' + t);
});

ok('a band at the noise floor never gets a runaway percentage', () => {
  const t = allText(run(driftHeavy()));
  const pcts = (t.match(/(\d+)%/g) || []).map((s) => parseInt(s, 10));
  assert.ok(pcts.every((n) => n <= 100), 'percentage over 100 on the wall: ' + JSON.stringify(pcts));
  assert.ok(!/\b\d{3,}%/.test(t), 'three-digit percentage present: ' + t);
});

ok('counts read as English, never "0 times" or "1 times"', () => {
  [dippy(), flatline(), driftHeavy()].forEach((fx) => {
    const t = allText(run(fx));
    assert.ok(!/\b0 times|\b1 times\b/.test(t), 'ungrammatical count: ' + t);
  });
});

ok('steadiness figures agree with the sentence around them', () => {
  const r = run(dippy());
  const rhythm = r.reads[1];
  const m = rhythm.sentence.match(/(\d+)% of the time/);
  if (m) {
    // "you stayed in" must not sit next to a low steadiness figure
    const inside = parseInt(m[1], 10);
    assert.ok(!(inside < 50 && /stayed in/.test(rhythm.sentence)),
      `"stayed in" claimed at ${inside}% steadiness: ` + rhythm.sentence);
  }
});

ok('every read carries a measured figure when there is data', () => {
  const r = run(dippy());
  r.reads.forEach((rd) => {
    assert.ok(rd.stat && rd.stat.value, `read ${rd.no} has no stat`);
    assert.ok(rd.stat.label, `read ${rd.no} has no stat label`);
  });
});

ok('an unmeasurable session omits figures rather than inventing them', () => {
  const r = computeReads({ samples: [{ t: 0, v: 0.5 }], bands: [], answers: {} });
  assert.ok(r.reads.every((rd) => !rd.stat), 'minimal reads must carry no stat block');
});

ok('the band narrative names the line it highlights', () => {
  const r = run(dippy());
  r.reads.forEach((rd) => {
    if (!rd.bandFocus) return;
    rd.bandFocus.forEach((k) => assert.ok(rd.bandNote.toLowerCase().includes(k),
      `read ${rd.no} highlights ${k} but never names it: ` + rd.bandNote));
  });
});

// THE bug the reveal shipped: a DEAD sidecar engagement line (all zeros, as real
// delta-dominated ear-EEG produces) with LIVE bands used to make every read
// degenerate — "0% of the time", "1 min 40 sec", contradictions. The focus
// signal must now come from the bands, so a dead line can't poison the reveal.
ok('a dead engagement line with live bands still reads', () => {
  const bands = [];
  for (let i = 0; i <= 120; i++) {
    const f = i / 120;
    // real-ish ear-EEG: delta-dominated, theta swinging, tiny beta
    bands.push({ t: i, delta: 0.55 + 0.1 * Math.sin(i / 9), theta: 0.22 + 0.12 * Math.sin(i / 5),
      alpha: 0.10, beta: 0.04 + 0.02 * Math.sin(i / 3), gamma: 0.004 });
  }
  const deadLine = bands.map((b) => ({ t: b.t, v: 0.04, vr: 0 }));   // the collapsed focusLine
  const r = computeReads({ samples: deadLine, bands, answers: { intake: {} }, interruptEegT: 60 });
  const t = r.reads.map((x) => [x.stat.value, x.sentence].join(' ')).join(' ');
  assert.ok(r.stats.settleSec < r.stats.totalSec, 'settle must not be the whole session: ' + r.stats.settleSec);
  assert.ok(!/\b0%\b/.test(t), 'no "0%" degeneracy off a dead line: ' + t);
  assert.ok(!(/stayed in/.test(t) && r.stats.insideBand < 50), 'no stayed-in contradiction');
  assert.ok(r.reads.every((rd) => rd.stat && rd.stat.value), 'every read still carries a figure');
});

// THE second wall bug: three honest-but-independent roundings that contradict
// each other ON SCREEN. Every figure in a sentence must agree with the other
// figures the guest can see next to it.
ok('the strongest stretch duration equals the difference of its own clocks', () => {
  [openingPeak(), dippy(), flatline(), driftHeavy()].forEach((fx) => {
    const s4 = run(fx).reads[3].sentence;
    const m = s4.match(/strongest (.+?) ran from (\d+:\d{2}) to (\d+:\d{2})/);
    assert.ok(m, 'strongest sentence shape: ' + s4);
    assert.notStrictEqual(m[2], m[3], 'a run must span two different clocks: ' + s4);
    assert.strictEqual(durToSec(m[1]), clockToSec(m[3]) - clockToSec(m[2]),
      'stated duration must equal the difference of the stated clocks: ' + s4);
  });
});

ok('a session too short for a from–to claim names the moment instead', () => {
  // a ~16s blip: WIN×16s ≈ 2s, so both clocks round to the same value — the
  // room once put "your strongest 5 sec ran from 0:15 to 0:15" on the wall
  const samples = [], bands = [];
  for (let i = 0; i <= 32; i++) {
    const t = i / 2, f = i / 32;
    const beta = 0.10 + 0.15 * Math.exp(-(((f - 0.85) / 0.15) ** 2));
    samples.push({ t, v: 0.3 + f * 0.5, vr: 0.3 + f * 0.5 });
    bands.push({ t, delta: 0.45, theta: 0.25 - 0.05 * f, alpha: 0.15, beta, gamma: 0.004 });
  }
  const r = computeReads({ samples, bands, answers: {}, interruptEegT: 8 });
  const s4 = r.reads[3].sentence;
  const m = s4.match(/ran from (\d+:\d{2}) to (\d+:\d{2})/);
  if (m) assert.notStrictEqual(m[1], m[2], 'self-identical range on the wall: ' + s4);
});

ok('a run starting at the top of the reading starts at 0:00, not 0:05', () => {
  const r = run(openingPeak());
  const rd = r.reads[3];
  assert.strictEqual(r.stats.strongFromSec, 0, 'strongFromSec: ' + r.stats.strongFromSec);
  assert.ok(/from 0:00 to /.test(rd.sentence), rd.sentence);
  assert.ok(rd.stat.value.startsWith('0:00'), rd.stat.value);
  assert.ok(!/at 0:00/.test(rd.ledger ? rd.ledger.did : ''), 'say "right from the start", never "at 0:00"');
});

ok('the settle percentage agrees with the settle time as displayed', () => {
  [openingPeak(), dippy(), flatline(), driftHeavy()].forEach((fx) => {
    const r = run(fx);
    const s1 = r.reads[0].sentence;
    const m = s1.match(/first (\d+)% of your reading/);
    if (!m) return;                       // the flat copy quotes no percentage
    const expect = Math.max(1, Math.round((r.stats.settleSec / r.stats.totalSec) * 100));
    assert.ok(Math.abs(parseInt(m[1], 10) - expect) <= 1,
      `${m[1]}% on the wall vs ${r.stats.settleSec}s of ${r.stats.totalSec}s (${expect}%): ` + s1);
  });
});

// The window a read HIGHLIGHTS on the chart is a claim too. Read 01 once
// shaded 28% of the session (a fixed floor) under copy claiming "the first
// 5%", and read 04's shade overshot its own stated clocks.
ok('a read window highlights what its copy claims', () => {
  [openingPeak(), dippy(), driftHeavy()].forEach((fx) => {
    const r = run(fx);
    const total = r.stats.totalSec;
    const settleEnd = r.reads[0].r1 * total;               // seconds the shade covers
    assert.ok(Math.abs(settleEnd - r.stats.settleSec) <= Math.max(2.6, total * 0.021),
      `settle shade ends ${settleEnd.toFixed(1)}s in but the copy claims ${r.stats.settleSec}s`);
    const r4 = r.reads[3];
    const m = r4.sentence.match(/ran from (\d+:\d{2}) to (\d+:\d{2})/);
    if (m) {
      assert.ok(Math.abs(r4.r0 * total - clockToSec(m[1])) <= 1.2,
        `strongest shade starts ${(r4.r0 * total).toFixed(1)}s vs stated ${m[1]}`);
      assert.ok(Math.abs(r4.r1 * total - clockToSec(m[2])) <= 1.2,
        `strongest shade ends ${(r4.r1 * total).toFixed(1)}s vs stated ${m[2]}`);
    }
    // a claimed recovery ("needed N sec to return") must shade exactly N sec
    const r3 = r.reads[2];
    if (r.stats.realDip && r.stats.recoverSec != null) {
      assert.ok(Math.abs((r3.r1 - r3.r0) * total - r.stats.recoverSec) <= 1.2,
        `recovery shade spans ${((r3.r1 - r3.r0) * total).toFixed(1)}s vs claimed ${r.stats.recoverSec}s`);
    }
  });
});

ok('the notification clock is exact, matching the marker on the chart', () => {
  // an EVENT timestamp is known to the second — gridding it to 5s drifted the
  // copy ("at 1:15") visibly off the marker the chart draws at the true time
  const fx = dippy();
  const r = computeReads({ samples: fx.samples, bands: fx.bands, answers: {}, interruptEegT: 73 });
  assert.ok(/at 1:13\./.test(r.reads[2].sentence), r.reads[2].sentence);
  assert.strictEqual(r.stats.interruptSec, 73, 'stats.interruptSec: ' + r.stats.interruptSec);
});

console.log(`\n${pass} checks passed`);
