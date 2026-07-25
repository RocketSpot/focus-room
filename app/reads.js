'use strict';
// ============================================================
// reads.js — the four reads, computed from the guest's own session.
// ------------------------------------------------------------
// Everything here is relative, directional, and about THIS session — never an
// absolute/clinical score, never a claim against a population. The
// committed-vs-actual contrasts come from the Beat-1 answers + the
// strongest-stretch guess.
//
// NUMBERS. Every read carries a `stat` (one measured figure, the headline) and
// its prose quotes real figures. All of them are things we actually recorded:
//   • durations, from the sample clock (rounded to 5s — measured, not to-the-
//     second theatre)
//   • movement, as a percentage of THE GUEST'S OWN session range
//   • band share, as each rhythm's percentage of the guest's own total signal
//     power in a window. Relative band power is what the sidecar reports, so
//     this is a direct readout, not a derived score.
// If a figure can't be computed honestly it is omitted, never estimated.
//
// Two scales matter:
//   • the RAW smoothed signal (vr) tells us how much the guest's engagement
//     actually MOVED — that's what flags a flat/unremarkable session and sets
//     the interruption-dip magnitude. We never stretch this.
//   • a min-span rescale gives the reveal LINE a legible "low for you → high for
//     you" shape WITHOUT exaggerating a tiny flat range into false drama.
// ============================================================

const WIN = 0.12;        // strongest-stretch window width (fraction of session)
const MIN_SPAN = 0.4;    // don't rescale a tiny (flat) raw range to full height

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function std(a) { const m = mean(a); return a.length ? Math.sqrt(mean(a.map((x) => (x - m) ** 2))) : 0; }
function regionOf(t) { return t < 0.34 ? 'the opening' : t < 0.67 ? 'the middle' : 'the ending'; }
function quote(s) { return s ? '“' + String(s).replace(/^[—\s]+/, '') + '”' : '—'; }

// ---- number formatting -------------------------------------------------
// Durations round to 5 seconds. The room measures, it doesn't stopwatch: a
// to-the-second figure would claim a precision the smoothed signal can't carry.
// A DURATION also floors at 5 ("0 sec" would be a nonsense claim) — but a CLOCK
// POSITION must not: 0:00 is a real place in the reading, and flooring it to
// 0:05 once put "your strongest 10 sec ran from 0:05 to 0:10" on the wall.
const round5 = (s) => Math.max(5, Math.round(s / 5) * 5);
const roundClock = (s) => Math.max(0, Math.round(s / 5) * 5);
function fmtDur(sec) {
  const s = round5(sec);
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} min ${r} sec` : `${m} min`;
}
// clock position within the reading, e.g. 5:10
function fmtClock(sec) {
  const s = roundClock(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
// The notification is a discrete EVENT with an exact timestamp — unlike the
// smoothed-line figures it needs no 5-second grid, and gridding it drifted the
// copy visibly off the chart marker ("at 1:15" over a marker drawn at 1:13).
function fmtClockExact(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const pct = (x) => Math.round(x * 100);
const times = (n) => (n === 0 ? 'not once' : n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
// A band's move against its own session level. Past ±100% the percentage stops
// being readable (and a small band's noise can produce "393% above"), so beyond
// that we say what happened in words instead of quoting a runaway figure.
const rose = (d) => (d >= 100 ? 'more than doubled against its session level' : `rose ${d}% above its session level`);
const fell = (d) => (d <= -50 ? 'dropped to less than half its session level' : `fell ${Math.abs(d)}% below its session level`);
// terse forms for a sentence's SECOND clause, where "its session level" has
// already been established. Repeating it made these notes long enough to
// overflow the prose block and force the type down to an unreadable size.
const roseT = (d) => (d >= 100 ? 'more than doubled' : `rose ${d}%`);
const fellT = (d) => (d <= -50 ? 'more than halved' : `fell ${Math.abs(d)}%`);

const GUESS_REGION = {
  'The opening': 'the opening',
  'The turn partway through': 'the middle',
  'The ending': 'the ending',
  "Honestly, I’m not sure": null,
  "Honestly, I'm not sure": null,
};

// plain-language band names for the reveal narrative
const BAND_SHORT = { delta: 'delta', theta: 'theta', alpha: 'alpha', beta: 'beta', gamma: 'gamma' };
// Phase 2A terminology (docs/eeg-hardware-confirmations.md): neutral descriptors.
// "active engagement" for beta is an INTERPRETATION, never the literal definition;
// gamma is "high-frequency activity", never "peak processing" (no cognition claim).
const BAND_MEANS = { delta: 'slow activity', theta: 'internal attention', alpha: 'calm alertness',
  beta: 'active engagement', gamma: 'high-frequency activity' };
const BANDS5 = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
// A rhythm holding only a few percent of total power is at the noise floor of a
// 4-electrode ear read (gamma always is; on a drift-heavy read beta can be too).
// A tiny absolute wobble there becomes a huge percentage — an early build put
// "beta ran 393% above its session level" on the wall off a band holding 3% of
// the signal. Below this share we never build a sentence on the band at all.
const SHARE_FLOOR = 0.04;

// Per-region band narrative — which measured rhythm led each read's window, what
// share of the guest's signal power it held there, and how that compares to their
// own session. Relative band power is measured directly (unlike a derived "focus"
// score), so the reveal tells its story through the bands and quotes the figures.
function bandLayer(bands, reads) {
  if (!bands || bands.length < 4) return null;
  const totalT = bands[bands.length - 1].t || 1;

  // whole-session share per band (each band's mean power / the sum of all five)
  const sessMean = {};
  BANDS5.forEach((k) => { sessMean[k] = mean(bands.map((b) => Math.max(0, +b[k] || 0))); });
  const sessTotal = BANDS5.reduce((s, k) => s + sessMean[k], 0) || 1e-9;
  const sessShare = {}; BANDS5.forEach((k) => { sessShare[k] = sessMean[k] / sessTotal; });

  // share per band inside a window
  const winShare = (r0, r1) => {
    const inR = bands.filter((b) => { const f = b.t / totalT; return f >= r0 && f <= r1; });
    const src = inR.length >= 2 ? inR : bands;
    const m = {}; BANDS5.forEach((k) => { m[k] = mean(src.map((b) => Math.max(0, +b[k] || 0))); });
    const tot = BANDS5.reduce((s, k) => s + m[k], 0) || 1e-9;
    const out = {}; BANDS5.forEach((k) => { out[k] = m[k] / tot; });
    return out;
  };
  // how far a band's share moved in this window vs the whole session, as a
  // percentage of its own session level. Null when the band sits at the floor.
  const shift = (sh, k) => {
    if (sessShare[k] < SHARE_FLOOR) return null;
    return Math.round(((sh[k] - sessShare[k]) / sessShare[k]) * 100);
  };
  // rank by how far each band moved, so the copy can never name the same band twice
  const movers = (sh) => BANDS5
    .map((k) => ({ k, d: shift(sh, k) }))
    .filter((x) => x.d !== null)
    .sort((a, b) => b.d - a.d);

  // Each entry is {note, focus}. `focus` names the band lines the note is
  // actually talking about, so the reveal can light exactly those and dim the
  // rest instead of the guest hunting for which squiggle is meant.
  return reads.map((rd) => {
    const sh = winShare(rd.r0, rd.r1);
    const mv = movers(sh);
    const up = mv[0], down = mv[mv.length - 1];
    // the loudest rhythm in the window, among the ones above the noise floor
    const loud = BANDS5.filter((k) => sessShare[k] >= SHARE_FLOOR)
      .sort((a, b) => sh[b] - sh[a])[0] || 'delta';
    const loudPct = pct(sh[loud]);

    if (rd.k === 'Interruption') {
      const b = shift(sh, 'beta');
      const slowK = (shift(sh, 'alpha') || -99) >= (shift(sh, 'theta') || -99) ? 'alpha' : 'theta';
      const sl = shift(sh, slowK);
      if (b !== null && b <= -5 && sl !== null && sl >= 5) {
        return { focus: ['beta', slowK],
          note: `Your ${BAND_SHORT.beta} rhythm ${fell(b)} here while ${BAND_SHORT[slowK]} ${roseT(sl)}.` };
      }
      if (b !== null && b <= -5) return { focus: ['beta'], note: `Your ${BAND_SHORT.beta} rhythm ${fell(b)} here. The notification is in the measurement, not just the line.` };
      if (sl !== null && sl >= 5) return { focus: [slowK], note: `Your slower ${BAND_SHORT[slowK]} rhythm ${rose(sl)} as the notification landed.` };
      return { focus: [loud], note: `The balance of your rhythms barely moved here. ${cap(BAND_SHORT[loud])} still held ${loudPct}% of the measured band power.` };
    }
    if (rd.k === 'Settle') {
      if (up && up.d >= 4 && down && down.d <= -4) return { focus: [up.k, down.k], note: `As you settled, ${BAND_SHORT[up.k]} ${rose(up.d)} and ${BAND_SHORT[down.k]} ${fellT(down.d)}. ${cap(BAND_SHORT[loud])} held ${loudPct}% of the measured band power.` };
      return { focus: [loud], note: `${cap(BAND_SHORT[loud])} held ${loudPct}% of the measured band power as you settled, with the other four steady around it.` };
    }
    if (rd.k === 'Rhythm') {
      if (up && up.d >= 4 && down && down.d <= -4) return { focus: [up.k, down.k], note: `Through the steady stretch ${BAND_SHORT[up.k]} ${rose(up.d)} and ${BAND_SHORT[down.k]} ${fellT(down.d)}. ${cap(BAND_SHORT[loud])} carried ${loudPct}% of the measured band power.` };
      return { focus: [loud], note: `Your five rhythms held their balance through this stretch. ${cap(BAND_SHORT[loud])} carried ${loudPct}% of the measured band power, steady throughout.` };
    }
    if (up && up.d >= 4) return { focus: [up.k], note: `In your strongest stretch ${BAND_SHORT[up.k]} ${rose(up.d)}, the largest shift of your five rhythms.` };
    return { focus: [loud], note: `${cap(BAND_SHORT[loud])} ran highest here, holding ${loudPct}% of the measured band power.` };
  });
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// The band whose REACTION to the notification is clearest: the change from the
// few seconds BEFORE the marker to the few seconds AFTER. That is the honest
// measure of "the notification's effect" — not the deviation from the whole
// session (which conflates the reaction with everything else). Only the
// attention bands (theta/alpha/beta) count: delta in awake mobile ear-EEG is
// motion/drift, gamma is muscle, so a jump there is a flinch, not attention.
// theta/alpha RISING is the classic mind-pulled-inward signal, weighted up.
// Returns { k, d } where d is the signed % change across the notification.
function interruptBandShift(bands, interruptT) {
  if (!bands || bands.length < 6) return null;
  const totalT = bands[bands.length - 1].t || 1;
  const sm = bands.map((b) => { let t = 0; BANDS5.forEach((k) => { t += Math.max(0, +b[k] || 0); }); t = t || 1e-9;
    const o = { f: b.t / totalT }; BANDS5.forEach((k) => { o[k] = Math.max(0, +b[k] || 0) / t; }); return o; });
  const sessShare = {}; BANDS5.forEach((k) => { sessShare[k] = mean(sm.map((s) => s[k])); });
  // The reaction window: from just before the marker to a few seconds after —
  // the immediate response, NOT the minute of aftermath that follows (where the
  // band often over-corrects the other way and would flip the story).
  let win = sm.filter((s) => s.f >= interruptT - 0.02 && s.f <= interruptT + 0.06);
  if (win.length < 2) { const c = interruptT; win = [...sm].sort((a, b) => Math.abs(a.f - c) - Math.abs(b.f - c)).slice(0, 3); }
  let best = null;
  ['theta', 'alpha', 'beta'].forEach((k) => {
    if (sessShare[k] < 0.02) return;                 // at the noise floor
    const wm = mean(win.map((s) => s[k]));
    const abs = wm - sessShare[k];                   // share-point swing (what's visible)
    const d = Math.round((abs / sessShare[k]) * 100);
    const score = ((k === 'theta' || k === 'alpha') && abs > 0 ? 1.4 : 1) * Math.abs(abs);
    if (!best || score > best.score) best = { k, d, abs, score };
  });
  return best;
}

// ============================================================
// THE FOCUS SIGNAL — derived from the BANDS, not the sidecar's engagement line.
// ------------------------------------------------------------
// The sidecar reports engagement as beta/(alpha+theta). On real in-ear EEG that
// is delta-dominated with a tiny, noisy beta, so the ratio collapses and the
// per-session scaling floors the whole line to zero. Every read then degenerates
// ("0% of the time", "no dip", contradictions). The BANDS, though, carry real
// structure — including the theta rise a notification actually produces. So we
// rebuild the focus signal here from the smoothed band shares.
// ============================================================
const FOCUS_SMOOTH_S = 9;   // physical-time smoothing window, NOT sample count
const SAME_T_EPS = 0.4;     // two samples this close in time are one moment (L/R buds)
const percentile = (sortedAsc, p) => {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((sortedAsc.length - 1) * p)));
  return sortedAsc[i];
};

// Phase 2A safety patch: the focus envelope is smoothed with a CENTERED window,
// which bled a post-notification decline backward so it appeared to begin BEFORE
// the marker (Phase-1 test #18). `eventEegT` splits the smoothing at the event so
// no post-event sample contributes to a pre-event value (or vice versa).
// NOTE: this is DISPLAY/feature smoothing only — the canonical unsmoothed spectral
// pipeline is the deferred phase; here we only stop the boundary bleed.
function bandFocusLine(bands, eventEegT) {
  if (!bands || bands.length < 6) return null;
  // 1) merge the L/R samples that land at the same instant (they arrive as pairs)
  const merged = [];
  for (const s of bands) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.t - s.t) < SAME_T_EPS) {
      BANDS5.forEach((k) => { last[k] = (last[k] * last._n + Math.max(0, +s[k] || 0)) / (last._n + 1); });
      last._n += 1;
    } else {
      const o = { t: s.t, _n: 1 }; BANDS5.forEach((k) => { o[k] = Math.max(0, +s[k] || 0); }); merged.push(o);
    }
  }
  if (merged.length < 4) return null;
  // 2) per-sample share of the moment's total power
  const sh = merged.map((s) => {
    let tot = 0; BANDS5.forEach((k) => { tot += s[k]; }); tot = tot || 1e-9;
    const o = { t: s.t }; BANDS5.forEach((k) => { o[k] = s[k] / tot; }); return o;
  });
  // 3) smooth into an envelope over a PHYSICAL window (band power undulates over
  //    tens of seconds; a sample-count window under-smooths short/sparse reads)
  const dt = sh.length > 1 ? (sh[sh.length - 1].t - sh[0].t) / (sh.length - 1) : 1;
  const half = Math.max(1, Math.round((FOCUS_SMOOTH_S / Math.max(dt, 0.4)) / 2));
  // split index at the notification — smoothing never crosses it, so the dip can
  // never appear before the event (nor the pre-event level bleed after it).
  let splitIdx = -1;
  if (eventEegT != null) { splitIdx = sh.findIndex((s) => s.t >= eventEegT); if (splitIdx < 0) splitIdx = sh.length; }
  const sm = sh.map((_, i) => {
    const o = { t: sh[i].t };
    let loJ = Math.max(0, i - half), hiJ = Math.min(sh.length - 1, i + half);
    if (splitIdx >= 0) {
      if (i < splitIdx) hiJ = Math.min(hiJ, splitIdx - 1);   // pre-event window stays pre-event
      else loJ = Math.max(loJ, splitIdx);                     // post-event window stays post-event
    }
    BANDS5.forEach((k) => {
      let a = 0, c = 0;
      for (let j = loJ; j <= hiJ; j++) { a += sh[j][k]; c++; }
      o[k] = c ? a / c : sh[i][k];
    });
    return o;
  });
  // 4) engagement index EI = beta / (alpha + theta), on the smoothed shares.
  //    Higher = more externally focused; a notification pushes theta up, which
  //    drives EI DOWN — the visible cost the guest is looking for.
  const ei = sm.map((s) => s.beta / (s.alpha + s.theta + 1e-9));
  // 5) normalise EI to its own session spread (robust percentiles) so the line
  //    uses the full height and shows the guest's real movement.
  const sorted = [...ei].sort((a, b) => a - b);
  const lo = percentile(sorted, 0.05), hi = percentile(sorted, 0.95);
  const span = Math.max(hi - lo, 1e-6);
  const med = percentile(sorted, 0.5) || 1e-9;
  // relative spread of EI: how much focus actually moved, level-independent. This
  // (not an absolute range) is what tells a genuinely EVEN reading from a moving
  // one, so a flat session still reads "remarkably even" and isn't stretched.
  const relSpread = (percentile(sorted, 0.9) - percentile(sorted, 0.1)) / med;
  const line = sm.map((s, i) => {
    const v = clamp01(0.03 + ((ei[i] - lo) / span) * 0.94);
    return { t: s.t, v, vr: v, ei: ei[i], shares: s };
  });
  return { line, flat: relSpread < 0.28, ei, shares: sm };
}

function computeReads({ samples, answers, interruptEegT, signalIssue, bands }) {
  answers = answers || {};
  // A recording can OPEN on a stray pre-anchor row (t≈2.4, then the clock
  // restarts at 0) — it corrupted the first seconds of everything derived from
  // the bands. Trim any leading rows that sit before a clock restart.
  if (Array.isArray(bands) && bands.length > 1) {
    let cut = 0;
    for (let i = 1; i < Math.min(bands.length, 12); i++) if (bands[i].t < bands[i - 1].t - 1e-6) cut = i;
    if (cut) bands = bands.slice(cut);
  }
  // Prefer the band-derived focus signal. Fall back to the sidecar's focusLine
  // only when there are no usable bands (legacy records, or a failed read).
  const bf = bandFocusLine(bands, interruptEegT);
  let flatOverride = null;
  if (bf && bf.line.length >= 8) { samples = bf.line; flatOverride = bf.flat; }
  const intake = answers.intake || {};

  if (!samples || samples.length < 8) {
    return { reads: minimalReads(), archetype: archetypeFrom(false, false), flat: true, region: null, lost: true,
      samplesForReveal: (samples || []).map((p) => ({ t: p.t, v: p.v })) };
  }

  const totalT = samples[samples.length - 1].t || 1;
  const rawT = samples.map((p) => p.t);
  const vrs = samples.map((p) => (typeof p.vr === 'number' ? p.vr : p.v));
  const vrmin = Math.min(...vrs), vrmax = Math.max(...vrs);
  const rawRange = vrmax - vrmin;                      // how much engagement actually moved
  const vspan = Math.max(rawRange, MIN_SPAN);

  // raw value at a session-fraction (for flatness + true dip magnitude)
  const vrAt = (f) => {
    const tt = f * totalT; let bi = 0;
    for (let i = 0; i < rawT.length; i++) if (Math.abs(rawT[i] - tt) < Math.abs(rawT[bi] - tt)) bi = i;
    return vrs[bi];
  };

  // finalized line for the reveal (legible, not exaggerated)
  const fin = samples.map((p, i) => ({ t: p.t, v: clamp01(0.03 + ((vrs[i] - vrmin) / vspan) * 0.94) }));
  const frac = (s) => clamp01(s / totalT);
  const at = (f) => {
    const tt = f * totalT; let best = fin[0];
    for (const p of fin) if (Math.abs(p.t - tt) < Math.abs(best.t - tt)) best = p;
    return best.v;
  };
  const secs = (f) => f * totalT;   // session-fraction → seconds into the reading

  // --- settle: first sustained hold in the upper part of the (finalized) range ---
  let settleFrac = 1;
  for (let i = 0; i < fin.length; i++) {
    if (fin[i].v >= 0.7) {
      const w = fin.slice(i, i + 4);
      if (w.length >= 3 && mean(w.map((p) => p.v)) >= 0.65) { settleFrac = frac(fin[i].t); break; }
    }
  }
  const quickly = settleFrac <= 0.33;

  // --- interruption window: position on the line, magnitude from RAW ---
  // A guest can finish the reading before either the plateau or the 75s
  // fallback fires — then there IS no notification, and nothing about one may
  // be claimed. intFired gates every interruption figure and claim below;
  // the 0.6 window position survives only as neutral geometry.
  const intFired = interruptEegT != null;
  const interruptT = intFired ? clamp01(interruptEegT / totalT) : 0.6;
  const preV = at(Math.max(0, interruptT - 0.02));
  let troughT = interruptT, troughV = 1;
  for (let f = interruptT; f <= Math.min(1, interruptT + 0.22); f += 0.01) {
    const v = at(f); if (v < troughV) { troughV = v; troughT = f; }
  }
  let recoveredT = troughT;
  for (let f = troughT; f <= Math.min(1, troughT + 0.45); f += 0.01) {
    if (at(f) >= preV - 0.06) { recoveredT = f; break; } recoveredT = f;
  }
  let troughVr = 1;
  for (let f = interruptT; f <= Math.min(1, interruptT + 0.22); f += 0.01) { const v = vrAt(f); if (v < troughVr) troughVr = v; }
  const rawDip = intFired ? Math.max(0, vrAt(Math.max(0, interruptT - 0.02)) - troughVr) : 0;
  const sharp = rawDip >= 0.35;
  const modest = rawDip < 0.18;

  // --- variability ONCE ENGAGED (after settle, before/after the dip) ---
  const engagedFrom = Math.max(settleFrac, 0.2);
  const mids = fin.filter((p) => {
    const f = frac(p.t);
    return f >= engagedFrom && f <= 0.9 && !(intFired && f >= interruptT - 0.02 && f <= recoveredT);
  });
  const variability = std(mids.map((p) => p.v));
  const variable = variability >= 0.14;

  // --- strongest stretch (highest-average window, excludes the dip) ---
  let bestStart = 0, bestAvg = -1;
  for (let s = 0; s <= 1 - WIN; s += 0.01) {
    if (intFired && s < recoveredT && s + WIN > interruptT) continue;
    let sum = 0, c = 0;
    for (let f = s; f <= s + WIN; f += 0.01) { sum += at(f); c++; }
    const avg = sum / c; if (avg > bestAvg) { bestAvg = avg; bestStart = s; }
  }
  const ssMid = bestStart + WIN / 2;
  const region = regionOf(ssMid);

  // FLAT = focus stayed even. When the signal came from the bands, flatness is
  // the EI relative-spread (level-independent) — the band line is normalised to
  // full height, so an absolute range can't tell even from moving. Legacy
  // focusLine path still uses the raw range.
  const flat = flatOverride != null ? (flatOverride && modest) : (rawRange < 0.30 && modest);
  const archetype = archetypeFrom(quickly, variable);

  // ================= THE NUMBERS =================
  // Everything below is a direct readout of the recorded line, expressed against
  // the guest's own session. Nothing here is scaled to a population or a norm.
  const settleSec = secs(settleFrac);
  const recoverSec = Math.max(0, secs(recoveredT) - secs(interruptT));
  const sessionAvg = mean(fin.map((p) => p.v));
  // Steadiness is measured against the level the guest held ONCE ENGAGED, not
  // against the whole-session average. The session average is dragged down by
  // the cold start and the interruption dip, so a genuinely steady reader
  // scored 15% "inside their steady band" while the same slide told them they
  // had stayed in — the two numbers were describing different baselines.
  const engagedAvg = mids.length ? mean(mids.map((p) => p.v)) : sessionAvg;
  // dip depth as a share of the guest's own measured range
  const dipPctOwn = rawRange > 1e-6 ? Math.round(Math.min(1, rawDip / rawRange) * 100) : 0;
  // how far the strongest window sat above the guest's own session average
  const strongAbove = Math.max(0, Math.round((bestAvg - sessionAvg) * 100));
  // how often the line crossed its own steady level: a plain, countable
  // measure of "waves" that needs no scale to be true
  let crossings = 0;
  for (let i = 1; i < mids.length; i++) {
    if ((mids[i - 1].v - engagedAvg) * (mids[i].v - engagedAvg) < 0) crossings++;
  }
  // share of the engaged stretch spent close to that steady level
  const insideBand = mids.length
    ? Math.round((mids.filter((p) => Math.abs(p.v - engagedAvg) <= 0.125).length / mids.length) * 100) : 0;
  const strongFromSec = secs(bestStart), strongToSec = secs(bestStart + WIN);
  // Every figure in a sentence must agree with the OTHERS ON SCREEN, not just
  // with the raw signal. Three honest-but-independent roundings once produced
  // "your strongest 10 sec ran from 0:05 to 0:10" — so the stretch's stated
  // duration is the difference of the two clocks the guest can see, and the
  // settle percentage is computed from the settle time as DISPLAYED.
  const strongShownSec = roundClock(strongToSec) - roundClock(strongFromSec);
  // On a very short session both clocks can round to the SAME value — "ran from
  // 0:15 to 0:15" — so a from–to claim needs the shown clocks to actually span.
  const strongClocksOk = strongShownSec >= 5;
  // Capped at 100: a session that never reached a settle hold has
  // settleFrac=1, and round5 could push the shown figure past the session
  // length ("the first 102% of your reading" — a nonsense claim).
  const settlePctShown = totalT > 0 ? Math.min(100, Math.max(1, Math.round((round5(settleSec) / Math.round(totalT)) * 100))) : 0;

  // ---- read flags (declared before the copy that quotes them) ----
  // Was there a drop worth putting a number on? A negligible dip used to be
  // written up as "your focus fell 0% of its own range and needed 5 sec to
  // return" — a non-event dressed as a finding. When nothing measurable happened
  // we say so.
  const realDip = intFired && dipPctOwn >= 5 && rawDip >= 0.04;
  // The rhythm read quotes `crossings`, so the wording is driven by the same
  // count rather than a separate variance flag that could disagree with it.
  const wavy = variable && crossings >= 3;
  // "You stayed in" may ONLY be said when the guest actually held their level.
  // A low insideBand with few crossings is not steadiness and not waves — it is
  // a slow drift, and calling it "you stayed in" contradicts the number beside it.
  const steady = insideBand >= 55;
  // The interruption's VISIBLE cost lives in the bands: a notification pushes the
  // mind inward, so theta (and alpha) rise even when the smoothed focus line
  // barely dips. Find that response so the read can always point at the real,
  // visible change rather than claiming "nothing moved".
  // A TIGHT window at the notification — a few seconds either side of the marker
  // — so we catch the immediate response (the theta spike) and don't average it
  // away into the minutes that follow.
  const intShift = intFired ? interruptBandShift(bands, interruptT) : null;
  const intVisible = intShift && Math.abs(intShift.d) >= 8;

  // ---- copy ----
  const settleWord = flat ? 'a calm, even settle' : (quickly ? 'quick to settle' : (settleFrac > 0.55 ? 'a slow burn' : 'an easy settle'));
  const rhythmWord = flat ? 'remarkably even' : (wavy ? 'short, quick waves' : (steady ? 'long, steady stretches' : 'a slow, wandering drift'));
  const dipWord = flat || modest ? 'a small, honest dip' : (sharp ? 'a sharp drop, a long climb back' : 'a clear dip, a steady climb back');

  const q1 = intake[0], q2 = intake[1];
  const lean = signalIssue ? ' These figures come from the clean stretches of your read.' : '';
  const rhythmDid = (flat
    ? `It held level. Your focus stayed within a quarter of its own range ${insideBand}% of the time.`
    : wavy ? `It moved in waves, crossing its own steady level ${times(crossings)}.`
      : steady ? `It ran in long stretches, crossing its own steady level only ${times(crossings)}.`
        : `It drifted slowly across its range, sitting inside its steady band only ${insideBand}% of the time.`) + lean;
  // The interruption's "your reading" line leads with whatever actually shows: a
  // measured focus dip, or the band response, or (rarely) an honest "barely moved".
  const intBandPhrase = intShift ? `${BAND_SHORT[intShift.k]}, your ${BAND_MEANS[intShift.k]}, ${intShift.d >= 0 ? roseT(intShift.d) : fellT(intShift.d)}` : '';
  // Phase 2A.1: the interpretation is HIDDEN from guests. beta/(alpha+theta) is an
  // unvalidated experimental ratio, the event time is a JS fire call (no firmware
  // onset marker), and recovery would be read off a smoothed line — so no
  // focus/direction/cost/recovery claim reaches the guest. The ledger just states
  // the neutral fact that a notification arrived; the experimental figures live in
  // the internal `provisional` block for engineering only.
  const dipDid = !intFired
    ? 'You finished before the room sent its notification.'
    : 'One notification arrived while you were reading.';

  const guessRegion = GUESS_REGION[answers.strongest] !== undefined ? GUESS_REGION[answers.strongest] : null;
  // "at 0:00" is a strange clock to quote — when the strongest run starts at the
  // very top of the reading, say that in words instead.
  const strongAt = roundClock(strongFromSec) === 0 ? 'right from the start' : `at ${fmtClock(strongFromSec)}`;
  const strongestDid = guessRegion == null
    ? `It peaked in ${region}, ${strongAt}.`
    : guessRegion === region ? `You guessed right. It peaked in ${region}, ${strongAt}.`
      : `You guessed ${guessRegion}. It peaked in ${region}, ${strongAt}.`;

  // The window a read HIGHLIGHTS is a claim too — read 04 marks exactly the
  // stretch its copy states, so read 01's window must end where the copy says
  // the settle ended (a fixed 0.28 floor once shaded 28% of the chart under a
  // sentence claiming "the first 5%"). Both windows end at their DISPLAYED
  // figures, with only a sliver-visibility floor.
  const settleWinFrac = totalT > 0
    ? Math.min(1, Math.max(0.02, round5(settleSec) / totalT)) : Math.max(0.02, settleFrac);
  const reads = [
    {
      index: 1, no: '01', title: 'How you settled', type: 'span',
      r0: 0, r1: settleWinFrac, anchorT: settleWinFrac * 0.55,
      k: 'Settle', v: settleWord, color: 'signal',
      stat: { value: fmtDur(settleSec), label: 'to reach your steady level' },
      sentence: flat
        ? `You reached your steady level ${fmtDur(settleSec)} in, without a sharp switch-on or a long warm-up.`
        : quickly ? `You were at your steady level ${fmtDur(settleSec)} in, which is the first ${settlePctShown}% of your reading. That is almost no warm-up at all.`
          : `You took ${fmtDur(settleSec)} to reach your steady level, the first ${settlePctShown}% of your reading. A deliberate climb, not a switch.`,
    },
    {
      index: 2, no: '02', title: 'Your attention rhythm', type: 'span',
      r0: settleWinFrac, r1: Math.max(settleWinFrac + 0.05, interruptT - 0.01),
      anchorT: (settleWinFrac + interruptT) / 2,
      k: 'Rhythm', v: rhythmWord, color: 'signal',
      stat: wavy
        ? { value: String(crossings), label: 'crossings of your own steady level' }
        : { value: `${insideBand}%`, label: 'of the time inside your steady band' },
      sentence: flat
        ? `Once in, your focus stayed within a quarter of its own range ${insideBand}% of the time. Level focus is a finding, not a null result.`
        : wavy ? `Once in, your focus crossed its own steady level ${times(crossings)}. It moved in real waves rather than holding one level.`
          : steady ? `Once you were in, you stayed in. Your focus sat inside its steady band ${insideBand}% of the time and crossed that level only ${times(crossings)}.`
            : `Your focus drifted across its range rather than settling on one level. It sat inside its steady band ${insideBand}% of the time.`,
      ledger: q2 ? { said: quote(q2), did: rhythmDid } : null,
    },
    {
      index: 3, no: '03', title: 'The notification', type: 'point',
      r0: interruptT,
      r1: realDip && totalT > 0 ? Math.min(1, interruptT + round5(recoverSec) / totalT) : recoveredT,
      anchorT: troughT,
      k: 'Interruption',
      v: !intFired ? 'never sent — you finished first' : 'one notification, mid-read',
      color: 'orange',
      // Phase 2A.1: interpretation HIDDEN from guests. No depth %, no recovery
      // seconds, no exact clock, no "cost"/"focus" claim — the metric is an
      // unvalidated ratio on an unvalidated event time. The headline is neutral;
      // the experimental figures are in `provisional` for engineering only.
      stat: null,
      sentence: !intFired
        ? 'You finished the reading before the room sent its one notification. That speed is its own finding.'
        : 'One notification arrived while you were reading. How your signal responded is being re-measured and is not shown here yet.',
      // No answer, no quotation. Omit the ledger entirely rather than fabricate.
      ledger: q1 ? { said: quote(q1), did: dipDid } : null,
      // INTERNAL ONLY — never rendered. Flagged provisional for the deferred
      // canonical interruption-cost phase; the metric is beta/(alpha+theta), NOT a
      // validated focus model.
      provisional: intFired ? {
        metric: 'betaAlphaThetaRatio', experimental: true, notValidated: true,
        dipPctOwnRange: realDip ? dipPctOwn : null,
        recoverSec: realDip ? round5(recoverSec) : null,
        interruptSec: Math.round(secs(interruptT)),
        timingConfidence: 'low', timingMethod: 'app_fire_call',
      } : null,
    },
    {
      index: 4, no: '04', title: 'Your strongest stretch', type: 'span',
      // highlight exactly the stretch the copy claims: the DISPLAYED clocks.
      // (When the clocks collapse on a tiny session, no from–to is claimed, so
      // the raw window stands.)
      r0: strongClocksOk && totalT > 0 ? roundClock(strongFromSec) / totalT : bestStart,
      r1: strongClocksOk && totalT > 0 ? Math.min(1, roundClock(strongToSec) / totalT) : bestStart + WIN,
      anchorT: ssMid,
      k: 'Strongest', v: 'your best run today', color: 'signal',
      stat: strongClocksOk
        ? { value: `${fmtClock(strongFromSec)}–${fmtClock(strongToSec)}`, label: 'your highest run of the session' }
        : { value: fmtClock(secs(ssMid)), label: 'your highest moment of the session' },
      sentence: strongClocksOk
        ? `Your strongest ${fmtDur(strongShownSec)} ran from ${fmtClock(strongFromSec)} to ${fmtClock(strongToSec)}, sitting ${strongAbove}% of your own range above your session average.`
        : `Your strongest moment came around ${fmtClock(secs(ssMid))}, sitting ${strongAbove}% of your own range above your session average.`,
      ledger: answers.strongest ? { said: quote(answers.strongest), did: strongestDid } : null,
    },
  ];

  // attach the band-based narrative note to each read (measured rhythms, not a focus score)
  const bandNotes = bandLayer(bands, reads);
  if (bandNotes) reads.forEach((rd, i) => { rd.bandNote = bandNotes[i].note; rd.bandFocus = bandNotes[i].focus; });
  // The interruption read points the chart at the band that actually moved at the
  // notification, so the eye lands on the visible change (the highlighted line
  // bumping at the orange marker) rather than hunting five squiggles.
  const intRead = reads.find((r) => r.k === 'Interruption');
  if (intRead && intVisible) {
    intRead.bandFocus = [intShift.k];
    // Phase 2A: directional, not an exact figure — relative band power, associative.
    intRead.bandNote = `At the notification, ${BAND_SHORT[intShift.k]} — your ${BAND_MEANS[intShift.k]} — ${intShift.d >= 0 ? 'rose' : 'eased'} relative to the rest of your reading (relative band power).`;
  }

  return {
    reads, archetype, flat, region,
    // null when the notification never fired — every surface keys its orange
    // marker off this, and a marker for an event that didn't happen is a
    // fabrication on the chart
    interruptT: intFired ? interruptT : null,
    samplesForReveal: fin,
    // the figures, kept alongside the prose so the card/profile/email quote the
    // SAME numbers the wall showed instead of recomputing their own
    stats: {
      totalSec: Math.round(totalT), settleSec: round5(settleSec),
      // null, not 0, when there was no measurable dip: a downstream surface must
      // not be able to print a recovery time for a recovery that never happened.
      // Phase 2A: interruption depth/recovery are INTERNAL + provisional — guest
      // surfaces must not print them (outputs.js suppresses the exact figures).
      realDip, recoverSec: realDip ? round5(recoverSec) : null,
      dipPctOwn, strongAbove, crossings, insideBand,
      strongFromSec: roundClock(strongFromSec), strongToSec: roundClock(strongToSec),
      interruptSec: intFired ? Math.round(secs(interruptT)) : null,
      interruptionProvisional: true,   // depth/recovery not validated (see timing)
    },
    // Phase 2A: the focus line is beta/(alpha+theta) on smoothed relative band
    // shares — NOT a validated focus model. Timing is the app fire call, not a
    // measured audible onset. Downstream surfaces label accordingly.
    metric: { name: 'betaAlphaThetaRatio', validated: false, kind: 'focus_indicator' },
    timing: { method: 'app_fire_call', confidence: 'low', firmwareMarker: false },
    meta: { settleFrac: +settleFrac.toFixed(3), variability: +variability.toFixed(3),
      rawRange: +rawRange.toFixed(3), rawDip: +rawDip.toFixed(3), sharp, modest, flat },
  };
}

function archetypeFrom(quickly, variable) {
  if (!quickly && !variable) return { label: 'deep', name: 'Deep Diver' };
  if (!quickly && variable) return { label: 'sprint', name: 'Sprinter' };
  if (quickly && !variable) return { label: 'steady', name: 'Steady Burner' };
  return { label: 'igniter', name: 'Quick Igniter' };
}

// Not enough signal to measure. No stat blocks here on purpose: a number we
// couldn't compute must not appear at all — and no QUALITATIVE claim either
// ("started cleanly and held" was an assertion about a session with almost no
// usable data). Each sentence says only what is true: the signal ran light,
// so the room says less rather than guessing.
function minimalReads() {
  return [
    { index: 1, no: '01', title: 'How you settled', type: 'span', r0: 0, r1: 0.4, anchorT: 0.2, k: 'Settle', v: 'a light signal', color: 'signal', sentence: 'The signal ran light this session, so the room says less about your settle rather than guessing.' },
    { index: 2, no: '02', title: 'Your attention rhythm', type: 'span', r0: 0.3, r1: 0.6, anchorT: 0.45, k: 'Rhythm', v: 'read honestly, briefly', color: 'signal', sentence: 'There was not enough clean signal to read a rhythm from, so no figure is claimed here.' },
    { index: 3, no: '03', title: 'The notification', type: 'point', r0: 0.55, r1: 0.75, anchorT: 0.62, k: 'Interruption', v: 'a quiet moment', color: 'orange', sentence: 'The signal was light around the notification, so we keep this one brief.' },
    { index: 4, no: '04', title: 'Your strongest stretch', type: 'span', r0: 0.7, r1: 0.85, anchorT: 0.78, k: 'Strongest', v: 'not singled out', color: 'signal', sentence: 'Too little clean signal survived to single out a strongest stretch, so none is claimed.' },
  ];
}

module.exports = { computeReads, archetypeFrom, BAND_MEANS };
