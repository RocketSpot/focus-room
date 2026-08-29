'use strict';
// ============================================================
// tests/quickstart.test.js — the operator command sheet cannot drift from
// the commands the code actually registers.
//   node tests/quickstart.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fails.push(name); console.log(' FAIL  ' + name + '\n       ' + e.message); }
}

const ROOT = path.join(__dirname, '..');
const sheet = fs.readFileSync(path.join(ROOT, 'quickstart.html'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');

ok('every registered global shortcut appears on the sheet', () => {
  // shortcuts register either directly or through opKey(), which tees the
  // press into the diagnostic trail before acting
  const regs = [...main.matchAll(/(?:globalShortcut\.register|opKey)\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(regs.length >= 3, 'expected at least 3 registrations, got ' + regs.length);
  for (const acc of regs) {
    // CommandOrControl+Shift+D must appear as its keycaps: cmd, shift, letter
    const letter = acc.split('+').pop();
    const wantsShift = /Shift/.test(acc);
    const rx = new RegExp(
      (wantsShift ? '<kbd>&#8679;</kbd>' : '') + '<kbd>' + letter + '</kbd>');
    assert.ok(rx.test(sheet.replace(/<kbd>&#8984;<\/kbd>/g, '')),
      acc + ' is registered in main.js but missing from quickstart.html');
  }
});

ok('the TV fullscreen key is on the sheet', () => {
  assert.ok(/before-input-event/.test(main) && /F11/.test(main), 'F11 handler moved?');
  assert.ok(/<kbd>F11<\/kbd>/.test(sheet), 'F11 missing from the sheet');
});

ok('the staff keys are on the sheet with their conditions', () => {
  assert.ok(/<kbd>E<\/kbd>/.test(sheet) && /staff mode/i.test(sheet));
  assert.ok(/<kbd>S<\/kbd>/.test(sheet) && /credential/i.test(sheet));
});

ok('all three dismissals exist: X, OK, and the keys', () => {
  assert.ok(/id="x"/.test(sheet) && /id="ok"/.test(sheet));
  assert.ok(/'Enter'/.test(sheet) && /'Escape'/.test(sheet));
  assert.ok(/window\.close\(\)/.test(sheet));
});

ok('the sheet ships with packaged builds', () => {
  const stage = fs.readFileSync(path.join(ROOT, 'build', 'stage-webroot.js'), 'utf8');
  assert.ok(/quickstart\.html/.test(stage), 'not in the webroot manifest');
});

ok('the sheet is the TV window\'s FIRST LOAD, not a floating panel', () => {
  assert.ok(/quickstart\.html/.test(main), 'main.js never loads the sheet');
  assert.ok(!/createQuickstartWindow/.test(main), 'the popup implementation should be gone');
  assert.ok(/FOCUSROOM_NO_QUICKSTART/.test(main), 'captures must be able to suppress it');
  assert.ok(/tvSurface = null/.test(main), 'a live beat must be able to reclaim the window');
});

ok('dismissal hands the window to the room, never closes it', () => {
  assert.ok(/location\.replace\('tv-constellation\.html'\)/.test(sheet),
    'done() must navigate to the constellation when served');
});

ok('no signal vocabulary and no em dashes on an operator-facing sheet', () => {
  assert.ok(!/—/.test(sheet), 'em dash found');
});


// The sheet must survive the boot-time state broadcast. An iPad or ops page
// left open from last time reconnects the instant the server binds and pushes
// 'constellation'; that must NOT evict the quickstart (a live surface may).
ok('the idle attractor cannot evict the quickstart sheet', () => {
  assert.ok(/quickstartPending && surface === 'constellation'/.test(main),
    'navigateTv must hold the sheet against a constellation push');
  assert.ok(main.indexOf("surface === 'constellation'") < main.indexOf('tvSurface = surface'),
    'the guard must sit before the navigation');
});
ok('dismissal syncs the surface tracker (no redundant reload after the sheet)', () => {
  assert.ok(/if \(!tvSurface\) tvSurface = m\[1\]/.test(main), 'tracker sync missing');
});

console.log('\n' + (fails.length ? `${fails.length} FAILURE(S)` : `all ${pass} checks passed`));
process.exit(fails.length ? 1 : 0);
