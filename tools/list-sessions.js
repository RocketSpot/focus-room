'use strict';
// ============================================================
// tools/list-sessions.js — browse the saved scan data.
//   npm run sessions          list every saved session (newest last)
//   npm run sessions -- <id>  dump one session's summary + file path
// Each session is a complete human-readable JSON under data/sessions/:
// the focus line, the whole-session band/metric stream, the baseline window,
// the four reads, archetype, answers, and guest events.
// ============================================================
const fs = require('fs');
const path = require('path');

// config.js requires electron, so resolve the data dir the same way it does
// without pulling electron in (this is a plain node CLI). In dev that's
// <repo>/data; an INSTALLED build writes under the OS userData dir instead, so
// check both or the tool reports "no sessions" on the room machine.
const repoRoot = path.resolve(__dirname, '..');
const APP_NAME = 'zone-focus-room';
const userData = process.env.APPDATA
  ? path.join(process.env.APPDATA, APP_NAME)                                  // win
  : path.join(process.env.HOME || '', 'Library', 'Application Support', APP_NAME); // mac
// FOCUSROOM_DATA_DIR wins, exactly as it does in config.js — without it the
// tool listed a stale dev directory on a machine whose room writes elsewhere.
const CANDIDATES = [
  ...(process.env.FOCUSROOM_DATA_DIR ? [path.join(process.env.FOCUSROOM_DATA_DIR, 'sessions')] : []),
  path.join(repoRoot, 'data', 'sessions'),
  path.join(userData, 'data', 'sessions'),
];
const DIR = CANDIDATES.find((d) => fs.existsSync(d)) || CANDIDATES[0];

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function human(rec) {
  const s = rec.stream || {};
  const frames = s.frames || [];
  const dur = frames.length ? `${Math.round(frames[frames.length - 1].t || 0)}s` : '—';
  return {
    id: rec.id,
    when: (rec.savedAt || rec.startedAt) ? new Date(rec.savedAt || rec.startedAt).toLocaleString() : '—',
    archetype: (rec.archetype && rec.archetype.name) || '—',
    reading: (rec.reading && rec.reading.title) || '—',
    reading_dur: dur,
    frames: frames.length,
    bands: (s.bands || []).length,
    focusLine: (rec.focusLine || []).length,
    baseline: (rec.baseline && rec.baseline.frames) ? rec.baseline.frames.length : 0,
    email: rec.email ? 'yes' : 'no',
  };
}

if (!fs.existsSync(DIR)) {
  console.log(`no sessions yet — nothing saved at ${DIR}`);
  process.exit(0);
}
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
if (!files.length) { console.log(`no sessions yet in ${DIR}`); process.exit(0); }

const wanted = process.argv[2];
if (wanted) {
  const hit = files.find((f) => f.includes(String(wanted)));
  if (!hit) { console.error(`no session matching "${wanted}"`); process.exit(1); }
  const file = path.join(DIR, hit);
  const rec = load(file);
  if (!rec) { console.error(`could not read ${file}`); process.exit(1); }
  console.log(`\n${file}\n`);
  console.log(human(rec));
  console.log('\ntop-level keys:', Object.keys(rec).join(', '));
  process.exit(0);
}

console.log(`\n${files.length} session(s) in ${DIR}\n`);
for (const f of files) {
  const rec = load(path.join(DIR, f));
  if (!rec) { console.log(`  ${f}  (unreadable)`); continue; }
  const h = human(rec);
  console.log(`  ${f}`);
  console.log(`    ${h.when} · ${h.archetype} · "${h.reading}" · read ${h.reading_dur}`);
  console.log(`    frames ${h.frames} · bands ${h.bands} · line ${h.focusLine} · baseline ${h.baseline} · email ${h.email}`);
}
console.log(`\n  npm run sessions -- <id>   for one session's detail\n`);
