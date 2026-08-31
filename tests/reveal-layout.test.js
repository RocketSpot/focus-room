'use strict';
// Regression net for the reveal failures visible in the 2026-08-31 TV photos:
// phase captions printed on top of one another and missing analysis stretches
// drawn as if they contained clean measurements.
const assert = require('assert');
const { placeRow, pickStripTier, measurementGaps } = require('../lib/reveal-layout.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.error(' FAIL  ' + name + ' >> ' + e.message); }
}

check('clustered phase labels are separated and stay inside the chart rails', () => {
  const widths = [180, 160, 205, 190];
  const left = placeRow([
    { c: 1010, w: widths[0] }, { c: 1035, w: widths[1] },
    { c: 1060, w: widths[2] }, { c: 1090, w: widths[3] },
  ], 172, 1480, 56);
  const placed = left.map((l, i) => ({ l, r: l + widths[i] })).sort((a, b) => a.l - b.l);
  assert.ok(placed[0].l >= 172, JSON.stringify(placed));
  assert.ok(placed[placed.length - 1].r <= 1480, JSON.stringify(placed));
  for (let i = 1; i < placed.length; i++) {
    assert.ok(placed[i].l - placed[i - 1].r >= 56 - 1e-6, JSON.stringify(placed));
  }
});

check('the phase strip falls back to shorter truthful labels before hiding any', () => {
  const rows = [
    { full: 'SETTLE · A VERY LONG SETTLE', short: 'SETTLE', wFull: 430, wShort: 90, active: false },
    { full: 'RHYTHM · LONG STEADY STRETCHES', short: 'RHYTHM', wFull: 470, wShort: 95, active: false },
    { full: 'INTERRUPTION · THETA FELL', short: 'INTERRUPTION', wFull: 420, wShort: 170, active: true },
    { full: 'STRONGEST · YOUR BEST RUN', short: 'STRONGEST', wFull: 390, wShort: 130, active: false },
  ];
  const picked = pickStripTier(rows, 1308, 56);
  assert.strictEqual(picked.length, 4, JSON.stringify(picked));
  assert.strictEqual(picked[2].text, rows[2].full, 'the active read should keep its full caption');
  assert.strictEqual(picked[0].text, 'SETTLE');
});

check('an impossibly narrow strip keeps only the active read, never cropped text', () => {
  const rows = [
    { full: 'SETTLE · SLOW', short: 'SETTLE', wFull: 190, wShort: 80, active: false },
    { full: 'INTERRUPTION · IT PULLED', short: 'INTERRUPTION', wFull: 240, wShort: 130, active: true },
  ];
  const picked = pickStripTier(rows, 140, 56);
  assert.deepStrictEqual(picked.map((p) => p.text), ['INTERRUPTION']);
});

check('timestamp holes become explicit no-measurement ranges even with a healthy link', () => {
  const rows = [];
  for (let t = 0; t <= 92; t += 1) {
    if ((t >= 21 && t < 27) || (t >= 60 && t < 75) || (t >= 84 && t < 89)) continue;
    rows.push({ t });
  }
  const result = measurementGaps(rows, []);
  assert.ok(result.cadence > 0.9 && result.cadence < 1.1, JSON.stringify(result));
  assert.deepStrictEqual(result.gaps, [
    { from: 21, to: 27 }, { from: 60, to: 75 }, { from: 84, to: 89 },
  ]);
});

check('known and inferred no-measurement ranges merge instead of double-shading', () => {
  const rows = [{ t: 0 }, { t: 1 }, { t: 2 }, { t: 10 }, { t: 11 }, { t: 12 }];
  const result = measurementGaps(rows, [{ from: 3, to: 9.5 }]);
  assert.deepStrictEqual(result.gaps, [{ from: 3, to: 10 }]);
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall reveal-layout checks passed');
process.exit(failures ? 1 : 0);
