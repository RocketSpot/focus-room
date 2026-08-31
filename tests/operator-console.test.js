'use strict';
// ============================================================
// The operator console must distinguish three different events:
//   1) a surface changing pages,
//   2) live transport whose analysis has not accepted a frame, and
//   3) an earbud link that is explicitly known to be down.
// The 2026-08-31 room run collapsed all three into "disconnected" warnings.
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const D = require(path.join(__dirname, '..', 'lib', 'diagnose.js'));

let pass = 0; const failures = [];
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { failures.push(name); console.error(' FAIL  ' + name + '\n       ' + e.message); }
}
function base(extra) {
  return Object.assign({
    beat: 'reading', sidecar: { running: true, ready: true, restarts: 0 },
    buds: { left: true, right: true }, budsEverUp: true,
    battery: {}, link: { eeg: 'live', buds: true, lost: false },
    everStreamed: true, lastFrameAgo: 9000, analysisAlive: false,
    transportAlive: false,
  }, extra || {});
}
function ids(result) { return result.alerts.map((a) => a.id); }

check('a live heartbeat defeats the frame-silence Bluetooth story', () => {
  const r = D.diagnose(base({ transportAlive: true }));
  assert.ok(ids(r).includes('analysis-picky'), JSON.stringify(ids(r)));
  assert.ok(!ids(r).includes('signal-stall'), JSON.stringify(ids(r)));
  assert.ok(!ids(r).includes('buds-off'), JSON.stringify(ids(r)));
});

check('fresh transport wins over a stale cached down verdict', () => {
  const r = D.diagnose(base({
    transportAlive: true,
    buds: { left: false, right: false },
    link: { eeg: 'holding', buds: false, lost: true },
  }));
  assert.ok(ids(r).includes('analysis-picky'), JSON.stringify(ids(r)));
  assert.ok(!ids(r).includes('signal-stall'), JSON.stringify(ids(r)));
  assert.ok(!ids(r).includes('buds-off'), JSON.stringify(ids(r)));
});

check('a live analyser tick defeats the frame-silence Bluetooth story', () => {
  const r = D.diagnose(base({ analysisAlive: true }));
  assert.ok(ids(r).includes('analysis-picky'));
  assert.ok(!ids(r).includes('signal-stall'));
});

check('silence without loss evidence stays explicitly unconfirmed', () => {
  const r = D.diagnose(base());
  const a = r.alerts.find((x) => x.id === 'signal-silent-unconfirmed');
  assert.ok(a, JSON.stringify(ids(r)));
  assert.ok(!ids(r).includes('signal-stall'));
  assert.ok(!/probably dropped/i.test(a.plain + ' ' + a.fix.join(' ')));
});

check('the first failed connection is waiting, never a dropped link', () => {
  const r = D.diagnose(base({
    beat: 'fit', buds: { left: false, right: false }, budsEverUp: false,
    link: { eeg: 'waiting', buds: false, lost: false }, everStreamed: false,
    lastFrameAgo: null,
  }));
  assert.ok(ids(r).includes('buds-waiting'), JSON.stringify(ids(r)));
  assert.ok(!ids(r).includes('buds-off'));
  assert.ok(!ids(r).includes('signal-stall'));
});

check('canonical link loss remains loud and actionable', () => {
  const r = D.diagnose(base({
    buds: { left: false, right: false },
    link: { eeg: 'holding', buds: false, lost: true },
  }));
  const link = r.alerts.find((a) => a.id === 'buds-off');
  const signal = r.alerts.find((a) => a.id === 'signal-stall');
  assert.ok(link && signal, JSON.stringify(ids(r)));
  assert.equal(link.level, 'bad');
  assert.ok(link.fix.some((s) => /Connect earbuds/.test(s)));
});

check('an explicit both-down report counts only after a bud was up', () => {
  const r = D.diagnose(base({
    buds: { left: false, right: false }, link: { eeg: 'holding', buds: null, lost: false },
  }));
  assert.ok(ids(r).includes('buds-off'), JSON.stringify(ids(r)));
});

check('one explicit side loss names the side and keeps recovery advice', () => {
  const r = D.diagnose(base({ buds: { left: true, right: false } }));
  const a = r.alerts.find((x) => x.id === 'one-bud');
  assert.ok(a && /right/.test(a.plain), JSON.stringify(ids(r)));
  assert.ok(a.fix.some((s) => /reconnect/i.test(s)));
});

check('routine TV page navigation is informational, not a disconnect warning', () => {
  const h = D.humanize('surface:client', { left: { role: 'tv' } });
  assert.equal(h.level, 'info');
  assert.ok(/page change/.test(h.text), h.text);
  assert.ok(!/disconnected/i.test(h.text), h.text);
});

check('known SDK status strings become clear operator language', () => {
  const h = D.humanize('sidecar:message', { type: 'eeg/connection', status: 'left_disconnected' });
  assert.equal(h.level, 'warn');
  assert.ok(/left earbud link dropped/i.test(h.text), h.text);
  assert.ok(!/left_disconnected/.test(h.text), h.text);
});

check('a deliberate full disconnect is a fact, not an alarm', () => {
  const h = D.humanize('sidecar:message', { type: 'eeg/connection', status: 'disconnected' });
  assert.equal(h.level, 'info');
  assert.ok(/No earbud/.test(h.text));
});

check('known engine errors become plain language without raw codes', () => {
  const h = D.humanize('sidecar:message', { type: 'error', code: 'no_eeg_data', msg: 'raw detail' });
  assert.equal(h.level, 'bad');
  assert.ok(/EEG stream did not produce data/.test(h.text), h.text);
  assert.ok(!/no_eeg_data/.test(h.text));
});

check('unknown SDK status is humanized rather than printed with underscores', () => {
  const h = D.humanize('sidecar:message', { type: 'eeg/connection', status: 'pair_profile_changed' });
  assert.ok(/Pair profile changed/.test(h.text), h.text);
  assert.ok(!/_/.test(h.text), h.text);
});

check('the canonical buds-disconnected event remains a warning', () => {
  const h = D.humanize('orch:event', { kind: 'buds_disconnected' });
  assert.equal(h.level, 'warn');
});

const ops = fs.readFileSync(path.join(__dirname, '..', 'ops.html'), 'utf8');
check('ops tracks heartbeat, stream history, and prior connection evidence', () => {
  for (const field of ['lastTransportAt', 'transportAlive', 'everStreamed', 'budsEverUp']) {
    assert.ok(new RegExp(field + '\\s*:').test(ops), field + ' state missing');
  }
  assert.ok(/function transportTick/.test(ops));
  assert.ok(/function rememberBuds/.test(ops));
});

check('fit and reading each start a fresh liveness stretch', () => {
  assert.ok(/function setBeat/.test(ops));
  assert.ok(/STREAMING_BEAT\[next\][\s\S]{0,240}lastFrameAt=0/.test(ops));
  assert.ok(/if\(m\.beat\)setBeat\(m\.beat\)/.test(ops));
});

check('operator controls explain themselves and are state-gated', () => {
  assert.ok((ops.match(/class="control-note"/g) || []).length >= 7);
  assert.ok(/function controlRule/.test(ops) && /function updateControls/.test(ops));
  assert.ok(/btn\.disabled=!rule\.on/.test(ops));
  assert.ok(/Synthetic input is locked out during every guest session/.test(ops));
  assert.ok(/Disconnect is locked while a guest is in the room/.test(ops));
  assert.ok(/available only during a live reading/.test(ops));
});

const core = fs.readFileSync(path.join(__dirname, '..', 'app', 'room-core.js'), 'utf8');
check('server repeats the synthetic-signal and notification safety checks', () => {
  assert.ok(/orchestrator\.beat === 'idle'/.test(core));
  assert.ok(/orchestrator\.forceInterruption\(\)/.test(core));
});

console.log('\n' + (failures.length ? failures.length + ' FAILURE(S)' : 'all ' + pass + ' checks passed'));
process.exit(failures.length ? 1 : 0);
