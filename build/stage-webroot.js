'use strict';
// ============================================================
// stage-webroot.js — copy the servable surfaces into build/webroot so
// electron-builder can ship them as resources/webroot. The Focus Room is
// local-first: every surface, font, and asset is served off-box, never a CDN.
// In dev the static server reads the repo root directly; this stages the
// identical tree for the packaged .exe.
// ============================================================
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const out = path.join(repoRoot, 'build', 'webroot');

// Curated list of what the LAN server serves. The design output is the visual
// source of truth — we ship it verbatim.
const ENTRIES = [
  'tokens.css',
  'index.html',
  'tv-live.html',
  'tv-signal.html',
  'tv-orb.html',
  'tv-reveal.html',
  'tv-constellation.html',
  'room-audio.html',
  'ipad-flow.html',
  'ops.html',
  'card.html',
  'profile.html',
  'email.html',
  'lib',
  'ipad',
  '_ds',
  'assets',
  'content',
];
// NOTE: app/renderer/** (the TV + diagnostic Electron windows) is NOT staged
// here — those load straight from the asar via loadFile(), identical in dev and
// prod. Only surfaces the iPad fetches over HTTP are staged into webroot.

function copy(src, dst) {
  if (!fs.existsSync(src)) {
    console.warn('[stage-webroot] skip missing:', path.relative(repoRoot, src));
    return;
  }
  fs.cpSync(src, dst, { recursive: true });
  console.log('[stage-webroot] +', path.relative(repoRoot, src));
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const entry of ENTRIES) {
  copy(path.join(repoRoot, entry), path.join(out, entry));
}

console.log('[stage-webroot] done ->', path.relative(repoRoot, out));
