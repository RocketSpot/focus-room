/* ============================================================
   ZONE — THE FOCUS ROOM
   focusline.js — the focus-line LANGUAGE, shared by every surface.
   --------------------------------------------------------------
   The live TV line, the reveal annotations, the printed card, the
   shareable profile and the emailed report all draw their line from
   THIS file, so the shape is identical everywhere.

   The line is a *relative within-session* engagement curve: the
   y-axis is "low for you" at the bottom, "high for you" at the top.
   There is NO absolute scale and NO number anywhere — by design,
   there is no place a fabricated precise figure could sit.

   The curve is generated deterministically (settle + gentle waves +
   one interruption dip) so two builders get the same line. Real EEG
   replaces the generator at build time; the SHAPE language stays.
   Engagement index modelled = beta / (alpha + theta), smoothed on a
   rolling ~4–8s window, read ~once a second — calm, never jittery.
   ============================================================ */
(function () {
  "use strict";

  // --- small deterministic noise so lines feel organic, not mechanical ---
  function hash(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }
  function noise(t, seed, freq) {
    var p = t * freq + seed * 100;
    var i = Math.floor(p), f = p - i;
    var a = hash(i + seed), b = hash(i + 1 + seed);
    var u = f * f * (3 - 2 * f);          // smoothstep
    return (a + (b - a) * u) * 2 - 1;     // -1..1
  }

  // --- the four archetypes, defined by the doc's 2×2 ----------------------
  //   settled SLOWLY/QUICKLY  ×  STEADY/VARIABLE once engaged
  //   slow+steady = Deep Diver | slow+variable = Sprinter
  //   quick+steady = Steady Burner | quick+variable = Quick Igniter
  var ARCH = {
    deep: {
      key: "deep", name: "Deep Diver", tone: "var(--c-arch-deep)",
      blurb: "Slow to settle, then long deep stretches.",
      lo: 0.14, plateau: 0.88, rate: 0.20,           // slow settle, high plateau
      waveAmp: 0.030, waveFreq: 5.2, noiseAmp: 0.018,
      interrupt: 0.60, dipDepth: 0.52, fall: 0.013, recover: 0.165, // long climb back
      settledAt: 0.34
    },
    igniter: {
      key: "igniter", name: "Quick Igniter", tone: "var(--c-arch-igniter)",
      blurb: "Settles fast, then shorter waves.",
      lo: 0.16, plateau: 0.82, rate: 0.045,          // fast settle
      waveAmp: 0.085, waveFreq: 11, noiseAmp: 0.03,
      interrupt: 0.57, dipDepth: 0.42, fall: 0.012, recover: 0.058, // fast recovery
      settledAt: 0.12
    },
    steady: {
      key: "steady", name: "Steady Burner", tone: "var(--c-arch-steady)",
      blurb: "Even focus, gentle waves throughout.",
      lo: 0.18, plateau: 0.72, rate: 0.075,
      waveAmp: 0.026, waveFreq: 6.5, noiseAmp: 0.014,
      interrupt: 0.60, dipDepth: 0.24, fall: 0.014, recover: 0.075, // modest dip
      settledAt: 0.18
    },
    sprint: {
      key: "sprint", name: "Sprinter", tone: "var(--c-arch-sprint)",
      blurb: "Intense short peaks, high variation.",
      lo: 0.15, plateau: 0.80, rate: 0.05,
      waveAmp: 0.150, waveFreq: 17, noiseAmp: 0.05,  // spiky
      interrupt: 0.58, dipDepth: 0.50, fall: 0.011, recover: 0.05,
      settledAt: 0.14
    }
  };

  // settle curve 0→1 (exponential approach)
  function settle(t, rate) { return 1 - Math.exp(-t / rate); }

  // one interruption dip: fast fall, asymmetric recovery
  function dip(t, a) {
    var d = t - a.interrupt;
    if (d < 0) return 0;
    var fall = 1 - Math.exp(-d / a.fall);   // 0→1 quickly
    var rec = Math.exp(-d / a.recover);     // 1→0 over recovery time
    // normalise so the trough ≈ -dipDepth
    var tp = a.fall * Math.log(1 + a.recover / a.fall); // time of trough
    var norm = (1 - Math.exp(-tp / a.fall)) * Math.exp(-tp / a.recover);
    return -a.dipDepth * (fall * rec) / (norm || 1);
  }

  // --- REAL SESSION SAMPLES (build change #1) -------------------------------
  // The reveal/card/profile/email feed real recorded samples in here under a
  // key (e.g. "session"); the entire rendering + analysis API below then works
  // on them instead of the ARCH generator. t is normalised to 0..1.
  var CUSTOM = {};
  function setSamples(key, pts, meta) {
    if (!pts || !pts.length) { delete CUSTOM[key]; return; }
    var tmax = pts[pts.length - 1].t || 1;
    var div = tmax > 1.0001 ? tmax : 1;        // samples may arrive as seconds
    var norm = pts.map(function (p) { return { t: p.t / div, v: Math.max(0, Math.min(1, p.v)) }; });
    var it = meta && meta.interruptT != null ? meta.interruptT / div : null;
    CUSTOM[key] = { pts: norm, interruptT: it };
  }
  function interpAt(pts, t) {
    if (t <= pts[0].t) return pts[0].v;
    var last = pts[pts.length - 1];
    if (t >= last.t) return last.v;
    for (var i = 1; i < pts.length; i++) {
      if (pts[i].t >= t) {
        var p0 = pts[i - 1], p1 = pts[i], f = (t - p0.t) / ((p1.t - p0.t) || 1);
        return p0.v + (p1.v - p0.v) * f;
      }
    }
    return last.v;
  }

  // the value of the line at session-fraction t (0..1) for an archetype OR,
  // when real samples were injected under `key`, interpolated from those.
  function valueAt(key, t) {
    var cu = CUSTOM[key];
    if (cu) return interpAt(cu.pts, t);
    var a = ARCH[key]; if (!a) return 0;
    var s = settle(t, a.rate);
    var base = a.lo + (a.plateau - a.lo) * s;
    // waves + noise only matter once engaged (scaled by settle)
    var wave = a.waveAmp * Math.sin(t * a.waveFreq * Math.PI * 2 + (key === "sprint" ? 1.3 : 0.4));
    if (key === "sprint") wave += a.waveAmp * 0.5 * Math.sin(t * a.waveFreq * 3.1 * Math.PI);
    var n = a.noiseAmp * noise(t, key.length + 3, key === "sprint" ? 26 : 14);
    var v = base + (wave + n) * s + dip(t, a);
    if (v < 0.04) v = 0.04;
    if (v > 0.98) v = 0.98;
    return v;
  }

  // sample n points across the session
  function sample(key, n) {
    n = n || 240;
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      pts.push({ t: t, v: valueAt(key, t) });
    }
    return pts;
  }

  // map a {t,v} sample to pixel space given a plot box
  // box: {x,y,w,h}  (v=1 → top of box, v=0 → bottom)
  function project(pt, box) {
    return {
      x: box.x + pt.t * box.w,
      y: box.y + (1 - pt.v) * box.h
    };
  }

  // Smooth SVG path through pixel points, using monotone cubic interpolation
  // (Fritsch–Carlson). Catmull-Rom, which this used to be, overshoots: between
  // two close samples it bulges past both of them, so a recorded line grew loops
  // and bends that were never in the data. Monotone tangents cannot overshoot —
  // the curve only turns where the samples turn. `tension` is accepted for
  // call-site compatibility and no longer changes the shape.
  function smooth(pixpts, tension) {
    var n = pixpts.length;
    if (n < 2) return "";
    if (n === 2) {
      return "M " + pixpts[0].x.toFixed(2) + " " + pixpts[0].y.toFixed(2) +
             " L " + pixpts[1].x.toFixed(2) + " " + pixpts[1].y.toFixed(2);
    }
    // secant slopes between consecutive points
    var dx = [], dy = [], m = [];
    for (var i = 0; i < n - 1; i++) {
      dx[i] = pixpts[i + 1].x - pixpts[i].x;
      dy[i] = pixpts[i + 1].y - pixpts[i].y;
      m[i] = dx[i] === 0 ? 0 : dy[i] / dx[i];
    }
    // tangents: average of neighbouring secants, forced to 0 at local extremes
    var t = [m[0]];
    for (var j = 1; j < n - 1; j++) {
      t[j] = (m[j - 1] * m[j] <= 0) ? 0 : (m[j - 1] + m[j]) / 2;
    }
    t[n - 1] = m[n - 2];
    // Fritsch–Carlson limiter: keep each tangent inside the circle of
    // monotonicity so no segment can bulge past its own endpoints
    for (var k = 0; k < n - 1; k++) {
      if (m[k] === 0) { t[k] = 0; t[k + 1] = 0; continue; }
      var a = t[k] / m[k], b = t[k + 1] / m[k], s = a * a + b * b;
      if (s > 9) { var f = 3 / Math.sqrt(s); t[k] = f * a * m[k]; t[k + 1] = f * b * m[k]; }
    }
    var d = "M " + pixpts[0].x.toFixed(2) + " " + pixpts[0].y.toFixed(2);
    for (var p = 0; p < n - 1; p++) {
      var h = dx[p] / 3;
      d += " C " + (pixpts[p].x + h).toFixed(2) + " " + (pixpts[p].y + h * t[p]).toFixed(2) + " " +
                   (pixpts[p + 1].x - h).toFixed(2) + " " + (pixpts[p + 1].y - h * t[p + 1]).toFixed(2) + " " +
                   pixpts[p + 1].x.toFixed(2) + " " + pixpts[p + 1].y.toFixed(2);
    }
    return d;
  }

  // full line path for an archetype within a box
  function linePath(key, box, opts) {
    opts = opts || {};
    var n = opts.samples || 200;
    var pts = sample(key, n).map(function (p) { return project(p, box); });
    return smooth(pts, opts.tension == null ? 1 : opts.tension);
  }

  // line path for the first `frac` of the session (for the live draw)
  function linePathTo(key, box, frac, opts) {
    opts = opts || {};
    var n = opts.samples || 200;
    var all = sample(key, n);
    var cut = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].t <= frac) cut.push(all[i]);
    }
    // add the exact leading point at `frac`
    cut.push({ t: frac, v: valueAt(key, frac) });
    var pix = cut.map(function (p) { return project(p, box); });
    return { d: smooth(pix, 1), head: pix[pix.length - 1] };
  }

  // bright sub-path over a region [t0,t1] (reveal highlight, card mark)
  function linePathRange(key, box, t0, t1, opts) {
    opts = opts || {};
    var n = opts.samples || 240;
    var all = sample(key, n);
    var seg = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].t >= t0 && all[i].t <= t1) seg.push(all[i]);
    }
    seg.unshift({ t: t0, v: valueAt(key, t0) });
    seg.push({ t: t1, v: valueAt(key, t1) });
    var pix = seg.map(function (p) { return project(p, box); });
    return smooth(pix, opts.tension == null ? 1 : opts.tension);
  }

  // closed area path under the line (for soft gradient fills)
  function areaPath(key, box, opts) {
    opts = opts || {};
    var n = opts.samples || 200;
    var pts = sample(key, n).map(function (p) { return project(p, box); });
    var d = smooth(pts, 1);
    d += " L " + (box.x + box.w).toFixed(2) + " " + (box.y + box.h).toFixed(2);
    d += " L " + box.x.toFixed(2) + " " + (box.y + box.h).toFixed(2) + " Z";
    return d;
  }

  // the pixel point at a given session-fraction
  function pointAt(key, t, box) { return project({ t: t, v: valueAt(key, t) }, box); }

  // the interruption window {start, trough, end-of-recovery}
  function interruptInfo(key) {
    var cu = CUSTOM[key];
    var start = cu && cu.interruptT != null ? cu.interruptT
      : (ARCH[key] ? ARCH[key].interrupt : 0.6);
    // find trough numerically just after the interruption
    var best = start, bestV = 1;
    for (var t = start; t < Math.min(1, start + 0.22); t += 0.002) {
      var v = valueAt(key, t);
      if (v < bestV) { bestV = v; best = t; }
    }
    // recovery point: where it climbs back near pre-dip level
    var pre = valueAt(key, Math.max(0, start - 0.01));
    var rec = best;
    for (var u = best; u < Math.min(1, best + 0.45); u += 0.002) {
      if (valueAt(key, u) >= pre - 0.04) { rec = u; break; }
      rec = u;
    }
    return { start: start, trough: best, troughV: bestV, recovered: rec, preV: pre };
  }

  // strongest stretch: window of highest average focus (excludes dip)
  function strongestStretch(key) {
    var win = 0.12, step = 0.01, best = 0.5, bestAvg = -1;
    var info = interruptInfo(key);
    for (var s = 0.0; s <= 1 - win; s += step) {
      // skip windows overlapping the dip
      if (s < info.recovered && s + win > info.start) continue;
      var sum = 0, c = 0;
      for (var t = s; t <= s + win; t += step) { sum += valueAt(key, t); c++; }
      var avg = sum / c;
      if (avg > bestAvg) { bestAvg = avg; best = s; }
    }
    return { start: best, end: best + win, mid: best + win / 2 };
  }

  // settle read: how the climb looked, rough words (no seconds)
  function settleWord(key) {
    var a = ARCH[key]; if (!a) return '';
    var r = a.rate;
    return r > 0.12 ? "a slow burn" : (r < 0.06 ? "quick to settle" : "an easy settle");
  }

  // live state word from value + slope at fraction t
  function stateWord(key, t) {
    var a = ARCH[key];
    if (!a) return "focused";
    if (t < a.settledAt * 0.9) return "settling";
    var info = interruptInfo(key);
    if (t >= info.start && t <= info.trough + 0.012) return "dipping";
    if (t > info.trough && t < info.recovered) return "recovering";
    return "focused";
  }

  window.FocusLine = {
    ARCH: ARCH,
    keys: ["deep", "igniter", "steady", "sprint"],
    setSamples: setSamples,   // inject real recorded session samples (build change #1)
    valueAt: valueAt,
    sample: sample,
    project: project,
    smooth: smooth,
    linePath: linePath,
    linePathTo: linePathTo,
    linePathRange: linePathRange,
    areaPath: areaPath,
    pointAt: pointAt,
    interruptInfo: interruptInfo,
    strongestStretch: strongestStretch,
    settleWord: settleWord,
    stateWord: stateWord
  };
})();
