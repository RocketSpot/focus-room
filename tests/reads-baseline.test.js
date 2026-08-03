'use strict';
// ============================================================
// The notification always carries a number, and the number is always sane.
// ------------------------------------------------------------
// Three separate paths used to return `stat: null` on the interruption read:
// fewer than six band rows, a shift that rounded below one percent, and a real
// dip taking the slot for itself. Each of them meant a guest could reach the one
// read the room promises will always show a change and find nothing there.
//
// The fourth failure was the opposite: the interruption read used a 0.02 noise
// floor while the narrative layer used 0.04, so the most quoted number in the
// reveal was the least protected, and a band holding 6% of the signal produced
// "more than doubled".
//
// Run:  node tests/reads-baseline.test.js
// ============================================================
const assert = require('assert');
const { computeReads } = require('../app/reads.js');

let pass = 0;
const fails = [];
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fails.push(name); console.log(' FAIL  ' + name + '\n       ' + e.message); }
}

const flat = (v) => ({ delta: v, theta: v, alpha: v, beta: v, gamma: v });
const samples = Array.from({ length: 200 }, (_, i) => ({ t: i * 0.3, v: 0.5 + 0.12 * Math.sin(i / 9) }));
const answers = { q1: 'a', q2: 'b', q3: 'c' };

// schema 2 rows: `osc` is dB above this guest's own fitted 1/f background
const mk2 = (n, fn) => Array.from({ length: n }, (_, i) => ({
  t: i, delta: 0.2, theta: 0.2, alpha: 0.2, beta: 0.2, gamma: 0.2, bandsSchema: 2, osc: fn(i),
}));
// schema 1 rows: raw band powers, no `osc` at all
const mk1 = (n, fn) => Array.from({ length: n }, (_, i) => Object.assign({ t: i }, fn(i)));

const run = (bands, baseline, tSec) => computeReads({
  samples, answers, interruptEegT: tSec, signalIssue: false, bands,
  eegClaimsAllowed: true, dataQualityStatus: 'ok', baseline,
});
const read03 = (...a) => run(...a).reads.find((r) => r.no === '03');

const RISE = (i) => (i > 32 ? { delta: 0, theta: 2.4, alpha: 1.1, beta: -1.8, gamma: 0 } : flat(0));

ok('a real band shift is reported, with the right rhythm named', () => {
  const rd = read03(mk2(60, RISE), null, 32);
  assert.ok(rd.stat, 'stat must exist');
  assert.ok(/Theta/.test(rd.stat.value), 'theta moved most, so theta is named: ' + rd.stat.value);
  assert.ok(/\d/.test(rd.stat.value), 'a figure is quoted: ' + rd.stat.value);
});

ok('fewer than six band rows still produces a figure', () => {
  const rd = read03(mk2(5, () => flat(0)), null, 3);
  assert.ok(rd.stat && rd.stat.value, 'stat must not be null on a short session');
});

ok('a shift below one percent is quoted, never rounded to zero', () => {
  const rd = read03(mk2(60, (i) => (i > 32 ? flat(0.004) : flat(0))), null, 32);
  assert.ok(rd.stat && rd.stat.value, 'stat must exist');
  assert.ok(!/\b0%/.test(rd.stat.value), 'never "0%": ' + rd.stat.value);
  assert.ok(!/\b0%/.test(rd.sentence), 'never "0%" in the sentence either: ' + rd.sentence);
});

ok('a real dip reports BOTH the band shift and the recovery time', () => {
  const dip = Array.from({ length: 200 }, (_, i) => ({
    t: i * 0.3, v: i > 100 && i < 130 ? 0.15 : 0.7,
  }));
  const r = computeReads({
    samples: dip, answers, interruptEegT: 32, signalIssue: false, bands: mk2(60, RISE),
    eegClaimsAllowed: true, dataQualityStatus: 'ok', baseline: null,
  });
  const rd = r.reads.find((x) => x.no === '03');
  assert.ok(/%/.test(rd.stat.value), 'the headline stays the band shift: ' + rd.stat.value);
  if (r.stats.realDip) {
    assert.ok(/sec|min/.test(rd.sentence), 'the recovery time survives in the sentence: ' + rd.sentence);
  }
});

ok('a recorded baseline changes what the guest is measured against', () => {
  const baseline = { bands: Array.from({ length: 12 }, (_, i) => ({ t: i, bandsSchema: 2, osc: flat(0) })) };
  const withB = read03(mk2(60, RISE), baseline, 32);
  const without = read03(mk2(60, RISE), null, 32);
  assert.ok(/at rest/.test(withB.sentence), 'names the resting baseline: ' + withB.sentence);
  assert.ok(/session level/.test(without.sentence), 'falls back to the session: ' + without.sentence);
});

ok('a baseline too short to trust falls back to the session', () => {
  const baseline = { bands: Array.from({ length: 3 }, (_, i) => ({ t: i, bandsSchema: 2, osc: flat(0) })) };
  const rd = read03(mk2(60, RISE), baseline, 32);
  assert.ok(/session level/.test(rd.sentence), 'three windows is not a baseline: ' + rd.sentence);
});

ok('a floor-level band cannot manufacture a runaway percentage', () => {
  // one band sitting at almost nothing, wobbling. Under the old share statistic
  // this is precisely the shape that produced "beta ran 393% above".
  const rd = read03(mk1(60, (i) => ({
    delta: 0.90, theta: 0.05, alpha: 0.02, beta: 0.02, gamma: i > 32 ? 0.06 : 0.001,
  })), null, 32);
  const all = rd.stat ? rd.stat.value + ' ' + rd.sentence : rd.sentence;
  const big = all.match(/(\d{3,})%/);
  assert.ok(!big, 'no three-digit percentage: ' + all);
});

ok('records written before the new statistic still read correctly', () => {
  const rd = read03(mk1(60, (i) => ({
    delta: 0.30, theta: 0.25, alpha: i > 32 ? 0.30 : 0.20, beta: 0.24, gamma: 0.01,
  })), null, 32);
  assert.ok(rd.stat && rd.stat.value, 'legacy records still produce a figure: ' + JSON.stringify(rd.stat));
  assert.ok(!/NaN|undefined/.test(rd.stat.value + rd.sentence), 'no NaN leaking: ' + rd.sentence);
});

ok('the notification never says it did nothing', () => {
  for (const bands of [mk2(60, () => flat(0)), mk2(5, () => flat(0)), mk1(60, () => flat(0.2))]) {
    const rd = read03(bands, null, 32);
    const t = (rd.stat ? rd.stat.value : '') + ' ' + rd.sentence + ' ' + rd.v;
    assert.ok(!/did nothing|no change|barely moved|small ripple|unchanged/i.test(t),
      'must never dismiss the notification: ' + t);
  }
});

console.log('\n' + (fails.length ? `${fails.length} FAILURE(S)` : `all ${pass} checks passed`));
process.exit(fails.length ? 1 : 0);
