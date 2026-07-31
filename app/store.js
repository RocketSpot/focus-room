'use strict';
// ============================================================
// store.js, local persistence for the Focus Constellation (and session
// records). The wall accumulates one anonymous dot per guest, placed by their
// archetype; it starts sparse and fills over weeks/months (Document.pdf).
//
// Backed by a small JSON file behind this interface. The master prompt names
// SQLite; this is swappable to better-sqlite3 / node:sqlite without touching
// callers, the data is tiny and append-only, so JSON is reliable and needs no
// native build for the .exe. (See docs/BUILD.md.)
// ============================================================
const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.dataDir, 'constellation.json');

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class Store {
  constructor() { this.dots = []; this._load(); }

  _load() {
    let raw;
    try { raw = fs.readFileSync(FILE, 'utf8'); }
    catch (_) { this.dots = []; return; } // no file yet, a fresh wall
    try { this.dots = (JSON.parse(raw).dots) || []; }
    catch (e) {
      // A corrupt file must never silently wipe months of dots: move it aside
      // for hand recovery and start fresh, loudly.
      const aside = `${FILE}.corrupt-${Date.now()}`;
      try { fs.renameSync(FILE, aside); } catch (_) {}
      /* eslint-disable-next-line no-console */
      console.error(`[store] constellation.json unreadable (${e.message}), moved aside to ${aside}, starting fresh`);
      this.dots = [];
    }
  }
  _save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      // atomic: write the whole file beside the real one, then rename over it,
      // so a crash mid-write can never leave a half-written constellation.
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ dots: this.dots }));
      fs.renameSync(tmp, FILE);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[store] save failed:', e.message); }
  }

  // add one anonymous dot for a finished session; sx/sy are stable scatter seeds
  addDot(archetype) {
    const id = (this.dots.length ? Math.max(...this.dots.map((d) => d.id)) : 0) + 1;
    const dot = { id, archetype: archetype || 'deep', sx: +gauss().toFixed(3), sy: +gauss().toFixed(3), t: Date.now() };
    this.dots.push(dot);
    this._save();
    return dot;
  }

  // Persist the FULL session, the focus line, the live band/metric stream, the
  // four reads, the archetype + its features, and the guest's answers, as one
  // human-readable JSON per session under data/sessions/. This is the real record
  // (the constellation dot is only an anonymous pin); it's also the dataset that
  // can later drive replay/analysis. Written atomically; one file per session id,
  // re-saved in place as email/door fill in. Returns the file path.
  saveSession(rec) {
    if (!rec || rec.id == null) return null;
    try {
      const dir = path.join(config.dataDir, 'sessions');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `session-${rec.id}.json`);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
      fs.renameSync(tmp, file);
      return file;
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[store] saveSession failed:', e.message); return null; }
  }

  list() { return this.dots; }
  count() { return this.dots.length; }
  countsByArchetype() {
    const c = { deep: 0, igniter: 0, steady: 0, sprint: 0 };
    for (const d of this.dots) if (c[d.archetype] != null) c[d.archetype] += 1;
    return c;
  }
}

module.exports = { Store };
