#!/usr/bin/env node
'use strict';
// ============================================================
// run-python-tests.js, put the sidecar's DSP tests inside `npm test`.
// ------------------------------------------------------------
// Until now no .py test was in the npm script at all, so the entire signal
// pipeline had no automated gate: the drift fix shipped, was wrong, and nothing
// noticed. Worse, the one DSP test printed SKIP and exited 0 when its imports
// failed, which is indistinguishable from passing.
//
// So this runner FAILS when it cannot run. A missing interpreter or a missing
// numpy is a broken test environment, not a reason to wave the build through.
// ============================================================
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');

function findPython() {
  const candidates = [
    process.env.FOCUSROOM_PYTHON,
    path.join(ROOT, 'venv', 'bin', 'python'),
    path.join(ROOT, 'venv', 'Scripts', 'python.exe'),
    'python3',
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import numpy, scipy'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

const py = findPython();
if (!py) {
  console.error('\n  python tests could NOT run: no interpreter with numpy and scipy.');
  console.error('  Tried $FOCUSROOM_PYTHON, venv/bin/python, venv/Scripts/python.exe, python3.');
  console.error('  This is a failure, not a skip: the signal pipeline would go untested.\n');
  process.exit(1);
}

const files = fs.readdirSync(TESTS).filter((f) => f.endsWith('.test.py')).sort();
if (!files.length) {
  console.error('  no tests/*.test.py found, which is itself wrong');
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  process.stdout.write(`\n=== ${f} ===\n`);
  // PYTHONUTF8: the tests print unicode (→, ≤); on Windows the console codec
  // is cp1252 and a bare print() CRASHES the test file mid-run. The pipeline
  // was fine — the environment wasn't. Force UTF-8 for the child.
  const r = spawnSync(py, [path.join(TESTS, f)],
    { stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } });
  if (r.status !== 0) failed += 1;
}

if (failed) {
  console.error(`\n  ${failed} python test file(s) FAILED\n`);
  process.exit(1);
}
console.log(`\n  ${files.length} python test file(s) passed\n`);
