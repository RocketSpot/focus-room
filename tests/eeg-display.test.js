'use strict';
// Phase 2A — live-display filter + decimation tests, and guardrails on the raw
// signal-check surface. The biquad below MIRRORS tv-signal.html's RBJ design
// (validated here for causality / passband / stopband / reset); the file itself
// is string-checked for the forbidden operations (filtfilt, splines, invented
// noise) so the real rendering path can't regress into them.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
let pass = 0;
const ok = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log(' FAIL  ' + name + ' — ' + e.message); process.exitCode = 1; } };

// ---- RBJ biquad (mirror of tv-signal.html) ----
function biquad(kind, f0, q, fs) {
  const w0 = 2 * Math.PI * f0 / fs, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * q);
  let b0, b1, b2;
  if (kind === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: 0, z2: 0 };
}
function step(bq, x) { const y = bq.b0 * x + bq.z1; bq.z1 = bq.b1 * x - bq.a1 * y + bq.z2; bq.z2 = bq.b2 * x - bq.a2 * y; return y; }
function rmsAt(freq, fs, hp, lp, n) {   // steady-state RMS gain at a frequency
  const H = biquad('hp', hp, 0.707, fs), L = biquad('lp', lp, 0.707, fs);
  let acc = 0, cnt = 0;
  for (let i = 0; i < n; i++) { const x = Math.sin(2 * Math.PI * freq * i / fs); const y = step(L, step(H, x)); if (i > n * 0.5) { acc += y * y; cnt++; } }
  return Math.sqrt(acc / cnt) / Math.SQRT1_2;   // normalise (input RMS = 1/√2)
}

console.log('\n-- live display filter (causal biquad) --');

ok('impulse response is one-sided (causal — no output before the impulse)', () => {
  const H = biquad('hp', 1, 0.707, 250), L = biquad('lp', 40, 0.707, 250);
  const out = [];
  for (let i = 0; i < 40; i++) out.push(step(L, step(H, i === 20 ? 1 : 0)));
  for (let i = 0; i < 20; i++) assert.strictEqual(out[i], 0, 'nonzero output at ' + i + ' before the impulse');
  assert.ok(Math.abs(out[20]) + Math.abs(out[21]) > 0, 'no response at/after the impulse');
});

ok('DC is blocked by the 1 Hz high-pass', () => {
  const g0 = rmsAt(0.05, 250, 1, 40, 4000);   // near-DC
  assert.ok(g0 < 0.25, 'DC gain too high: ' + g0.toFixed(3));
});

ok('10 Hz (EEG band) passes near unity', () => {
  const g = rmsAt(10, 250, 1, 40, 4000);
  assert.ok(g > 0.7, '10 Hz gain too low: ' + g.toFixed(3));
});

ok('60 Hz (line) is attenuated above the 40 Hz low-pass', () => {
  const g = rmsAt(60, 250, 1, 40, 4000);
  assert.ok(g < 0.5, '60 Hz gain too high: ' + g.toFixed(3));
});

ok('display-filter frequency response measured 0.2–60 Hz (monotone edges, flat mid)', () => {
  const freqs = [0.2, 0.5, 1, 2, 10, 20, 30, 40, 45, 50, 60];
  const g = {}; freqs.forEach((f) => { g[f] = rmsAt(f, 250, 1, 40, 6000); });
  // low edge: strictly rising 0.2 → 2 Hz (high-pass roll-on)
  assert.ok(g[0.2] < g[0.5] && g[0.5] < g[1] && g[1] < g[2], 'HP edge not monotone: ' + JSON.stringify(g));
  // passband: near unity across the EEG band
  assert.ok(g[10] > 0.85 && g[20] > 0.8 && g[30] > 0.6, 'passband too low: ' + JSON.stringify(g));
  // high edge: falling toward and past the 40 Hz corner
  assert.ok(g[45] < g[30] && g[60] < g[45] && g[60] < 0.5, 'LP edge not monotone: ' + JSON.stringify(g));
  // DC strongly rejected
  assert.ok(g[0.2] < 0.15, 'DC not rejected: ' + g[0.2]);
});

ok('phase (hence group delay) is frequency-dependent — no single fixed latency', () => {
  // analytic phase of the HP+LP cascade at z=e^jw; different frequencies → different
  // phase delay, so the display filter must NOT be reported as one fixed latency.
  function phaseAt(freq) {
    const w = 2 * Math.PI * freq / 250;
    function ph(bq) {
      const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nre = bq.b0 + bq.b1 * cw + bq.b2 * c2, nim = -(bq.b1 * sw + bq.b2 * s2);
      const dre = 1 + bq.a1 * cw + bq.a2 * c2, dim = -(bq.a1 * sw + bq.a2 * s2);
      return Math.atan2(nim, nre) - Math.atan2(dim, dre);
    }
    return ph(biquad('hp', 1, 0.707, 250)) + ph(biquad('lp', 40, 0.707, 250));
  }
  const pdMs = (f) => -phaseAt(f) / (2 * Math.PI * f) * 1000;   // phase delay, ms
  const d5 = pdMs(5), d10 = pdMs(10), d20 = pdMs(20);
  assert.ok(Math.abs(d5 - d20) > 1, 'phase delay barely varies (' + d5.toFixed(1) + '..' + d20.toFixed(1) + 'ms) — should be frequency-dependent');
});

ok('reset zeroes filter state (no carry-over across a long gap)', () => {
  const H = biquad('hp', 1, 0.707, 250);
  for (let i = 0; i < 50; i++) step(H, 1000 * Math.sin(i));
  H.z1 = 0; H.z2 = 0;                              // reset
  const y = step(H, 0);
  assert.strictEqual(y, 0, 'state not cleared after reset: ' + y);
});

ok('NaN input does not produce a fabricated finite output', () => {
  const H = biquad('hp', 1, 0.707, 250);
  const y = step(H, NaN);
  assert.ok(Number.isNaN(y), 'NaN should propagate as NaN (gap), got ' + y);
});

console.log('\n-- min-max decimation --');

function minMaxColumns(samples, indices, wpx, leftIdx, rightIdx) {
  const span = rightIdx - leftIdx || 1, cols = new Array(wpx);
  for (let s = 0; s < samples.length; s++) {
    const gi = indices[s], v = samples[s];
    const px = Math.floor(((gi - leftIdx) / span) * (wpx - 1));
    if (px < 0 || px >= wpx) continue;
    if (!cols[px]) cols[px] = { min: v, max: v };
    else { if (v < cols[px].min) cols[px].min = v; if (v > cols[px].max) cols[px].max = v; }
  }
  return cols;
}

ok('a brief spike survives decimation (min-max, not averaging)', () => {
  // 500 samples into 50 columns (10:1); a single spike must remain in its column's max
  const N = 500, vals = new Array(N).fill(0), idx = Array.from({ length: N }, (_, i) => i);
  vals[123] = 999;
  const cols = minMaxColumns(vals, idx, 50, 0, N);
  const col = cols[Math.floor((123 / N) * 49)];
  assert.strictEqual(col.max, 999, 'spike lost — mean downsampling would hide it');
});

ok('a gap column stays empty (no interpolation across missing data)', () => {
  const idx = [0, 1, 2, 200, 201, 202], vals = [1, 1, 1, 1, 1, 1];   // big hole 3..199
  const cols = minMaxColumns(vals, idx, 50, 0, 202);
  const midCol = cols[25];
  assert.strictEqual(midCol, undefined, 'a column inside the gap must have no sample');
});

console.log('\n-- guardrails on tv-signal.html (the real raw scope) --');
const html = fs.readFileSync(path.join(__dirname, '..', 'tv-signal.html'), 'utf8');

ok('does not use filtfilt (non-causal) anywhere', () => assert.ok(!/filtfilt/i.test(html)));
ok('raw scope does not spline the samples (no FocusLine.smooth / bezier curve)', () => {
  assert.ok(!/FocusLine\.smooth/.test(html), 'must not spline raw EEG');
  assert.ok(!/quadraticCurveTo|bezierCurveTo/.test(html), 'must not bezier-smooth raw EEG');
});
ok('no invented noise in the render/filter path (Math.random only in reconnect jitter)', () => {
  const lines = html.split('\n').filter((l) => /Math\.random/.test(l));
  assert.ok(lines.every((l) => /connectLive|setTimeout/.test(l)), 'Math.random outside reconnect: ' + lines.join(' | '));
});
ok('draws straight segments (lineTo) into a canvas ring buffer', () => {
  assert.ok(/getContext\('2d'\)/.test(html) && /lineTo\(/.test(html));
});
ok('no decorative band lanes / "peak processing" on the raw scope', () => {
  assert.ok(!/peak processing/.test(html) && !/lane:/.test(html));
});
ok('carries a persistent SIMULATED badge and no µV unit on displayed amplitude', () => {
  assert.ok(/simBadge/.test(html) && /Simulated data/i.test(html));
  // µV must not appear as a rendered UNIT (inside a string literal); an honest
  // "no µV" policy comment is allowed.
  assert.ok(!/['"`][^'"`\n]*µV/.test(html), 'must not label µV on displayed values (calibration unverified)');
  assert.ok(/relative display amplitude/i.test(html));
});

console.log('\n-- engineering-view access control (staff-gated) --');

ok('the E-key engineering toggle is GATED (no unconditional engOn flip)', () => {
  // the old unconditional single-line toggle must be gone
  assert.ok(!/e\.key === 'E'\)\s*\{\s*engOn = !engOn;\s*\}/.test(html), 'unconditional E toggle still present');
  assert.ok(/engToggleAllowed\(\)/.test(html), 'no engToggleAllowed gate');
  assert.ok(/if \(!engToggleAllowed\(\)\) return;/.test(html), 'E key not guarded by engToggleAllowed');
});
ok('NO hardcoded staff PIN (pre-merge hardening item 1)', () => {
  assert.ok(!/['"]2468['"]/.test(html), 'the old hardcoded PIN 2468 is still present');
  assert.ok(!/STAFF_PIN\s*=\s*['"][^'"]/.test(html), 'STAFF_PIN assigned a string literal (must come from launcher config)');
  assert.ok(/STAFF_CFG\.pin/.test(html) && /__FOCUSROOM__/.test(html), 'PIN not sourced from the launcher config');
});
ok('staff activation is LAUNCHER-gated (item 2 — bare params dead in guest builds)', () => {
  assert.ok(/STAFF_UI/.test(html), 'no STAFF_UI build gate');
  assert.ok(/paramUnlock = STAFF_UI &&/.test(html), 'bare ?staff/?dev not gated behind STAFF_UI');
  assert.ok(/window\.__FOCUSROOM__ && window\.__FOCUSROOM__\.staff/.test(html), 'staff config not read from the launcher preload');
  assert.ok(/if \(!STAFF_UI \|\| STAFF_PIN === ''\) return;/.test(html), 'PIN unlock not disabled without a staff build + configured credential');
});
ok('staff mode is visibly indicated', () => assert.ok(/staffBadge/.test(html)));
ok('test/ops hooks (window.__scope setStaff/pressE) exist ONLY in a dev/staff build', () => {
  // the ungated bypass — window.__scope.setStaff(true) flipping staff mode with no gate — must
  // be behind the STAFF_UI build flag, so a plain-browser guest gets no __scope at all.
  assert.ok(/if \(STAFF_UI\) \{[\s\S]{0,900}window\.__scope = \{/.test(html), 'window.__scope not gated behind STAFF_UI');
  assert.ok(/if \(STAFF_UI\) \{[\s\S]{0,1200}setStaff:/.test(html), 'the setStaff hook is not gated behind STAFF_UI');
});
ok('engineering access is logged locally WITHOUT raw samples', () => {
  assert.ok(/focusroom\.eng\.accessLog/.test(html), 'no local access log');
  // the access log + any console line must never carry raw channel data
  assert.ok(!/localStorage\.setItem\([^)]*(rawRing|filtRing|samples|adc)/i.test(html), 'raw data written to localStorage');
  assert.ok(!/sessionStorage/.test(html), 'sessionStorage must not be used for raw EEG');
  assert.ok(!/console\.(log|info|warn|debug)\([^)]*(rawRing|filtRing|\bsamples\b)/i.test(html), 'raw data written to console');
});
ok('leaving staff mode returns to consumer view + clears the eng buffer', () => {
  assert.ok(/setStaffMode\(false/.test(html), 'no exit-staff path');
  // the off-branch must turn engOn off and blank the engineering element
  assert.ok(/engOn = false;[\s\S]{0,120}innerHTML = '';/.test(html), 'leaving staff mode does not clear the eng view');
});

// behavioural mirror of the hardened unlock (staffMode) + the E gate.
function staffMode(staffUi, pin, search) {
  const Q = new URLSearchParams(search || '');
  const STAFF_UI = staffUi === true, STAFF_PIN = String(pin || '');
  const paramUnlock = STAFF_UI && (Q.get('staff') === '1' || Q.has('dev'));
  const tokenUnlock = STAFF_PIN !== '' && String(Q.get('staff') || '') === STAFF_PIN;
  return paramUnlock || tokenUnlock;
}
function gate(unlocked) {
  let engOn = false;
  return { pressE: () => { if (unlocked === true) engOn = !engOn; return engOn; } };
}
ok('production guest build: ?staff=1 / ?dev=1 do NOT unlock (item 2)', () => {
  assert.strictEqual(staffMode(false, '', 'staff=1'), false);
  assert.strictEqual(staffMode(false, '', 'dev=1'), false);
  // and a plain browser with no launcher (no config) stays locked for any param
  assert.strictEqual(staffMode(false, '', 'staff=1&dev=1'), false);
});
ok('dev/staff build: ?staff=1 unlocks (launcher-established)', () => {
  assert.strictEqual(staffMode(true, '', 'staff=1'), true);
});
ok('launcher-issued credential unlocks; a guess does not (item 1)', () => {
  assert.strictEqual(staffMode(false, 'abc123', 'staff=abc123'), true);   // matches configured credential
  assert.strictEqual(staffMode(false, 'abc123', 'staff=2468'), false);    // wrong value
  assert.strictEqual(staffMode(false, '', 'staff=anything'), false);      // no credential configured
});
ok('ordinary guest mode: pressing E cannot open the engineering view', () => {
  const g = gate(staffMode(false, '', 'staff=1'));   // production build, param present
  assert.strictEqual(g.pressE(), false);
  assert.strictEqual(g.pressE(), false);
});
ok('staff mode: pressing E toggles the engineering view', () => {
  const g = gate(staffMode(true, '', 'staff=1'));
  assert.strictEqual(g.pressE(), true);
  assert.strictEqual(g.pressE(), false);
});

console.log('\n' + (process.exitCode ? 'FAILURES' : pass + ' checks passed'));
