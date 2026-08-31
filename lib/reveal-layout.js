'use strict';
// ============================================================
// Reveal layout helpers shared by the TV surface and its regression tests.
// Pure on purpose: the collision and missing-measurement rules can be proved
// without a browser, while tv-reveal.html remains responsible for drawing.
// ============================================================
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RevealLayout = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Slide centred boxes apart while keeping every box inside [x0, x1]. The
  // caller first uses pickStripTier(), which guarantees the row can fit.
  function placeRow(boxes, x0, x1, pad) {
    if (!Array.isArray(boxes) || !boxes.length) return [];
    const order = boxes.map((b, i) => ({
      i,
      c: Number.isFinite(+b.c) ? +b.c : x0,
      w: Math.max(0, Number.isFinite(+b.w) ? +b.w : 0),
    })).sort((a, b) => a.c - b.c);
    let cursor = x0;
    for (const box of order) {
      box.l = Math.max(cursor, box.c - box.w / 2);
      cursor = box.l + box.w + pad;
    }
    cursor = x1;
    for (let i = order.length - 1; i >= 0; i--) {
      const box = order[i];
      box.l = Math.min(box.l, cursor - box.w);
      cursor = box.l - pad;
    }
    const out = [];
    for (const box of order) out[box.i] = box.l;
    return out;
  }

  // Prefer the most descriptive label tier that physically fits. When the
  // full captions do not fit, non-active captions become their short phase
  // names; the last resort names only the active read. Text is never cropped.
  function pickStripTier(rows, width, pad) {
    if (!Array.isArray(rows) || !rows.length || !(width > 0)) return [];
    const tiers = [
      (r) => ({ text: r.full, w: r.wFull, keep: true }),
      (r) => ({ text: r.active ? r.full : r.short, w: r.active ? r.wFull : r.wShort, keep: true }),
      (r) => ({ text: r.short, w: r.wShort, keep: true }),
      (r) => ({ text: r.full, w: r.wFull, keep: !!r.active }),
      (r) => ({ text: r.short, w: r.wShort, keep: !!r.active }),
    ];
    for (const tier of tiers) {
      const picked = [];
      rows.forEach((row, i) => {
        const p = tier(row);
        if (p.keep) picked.push({ i, text: String(p.text || ''), w: Math.max(0, +p.w || 0) });
      });
      if (!picked.length) continue;
      const total = picked.reduce((n, p) => n + p.w, pad * Math.max(0, picked.length - 1));
      if (total <= width) return picked;
    }
    return [];
  }

  function median(values) {
    const a = values.filter((v) => Number.isFinite(v) && v > 0).sort((x, y) => x - y);
    if (!a.length) return 0;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  // The orchestrator records known stalls, but a chart must also break across
  // rejected analysis windows: Bluetooth can be perfectly healthy while no
  // clean measurement is accepted. Infer those blank ranges from timestamp
  // jumps, then merge them with the explicit ranges. Every returned gap means
  // only one thing: the room has no clean measurement to draw there.
  function measurementGaps(rows, explicit, options) {
    const opts = options || {};
    const times = (Array.isArray(rows) ? rows : [])
      .map((r) => +((r || {}).t))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
      .filter((t, i, all) => i === 0 || Math.abs(t - all[i - 1]) > 0.25);
    const steps = [];
    for (let i = 1; i < times.length; i++) steps.push(times[i] - times[i - 1]);
    const cadence = median(steps) || 1;
    const threshold = Math.max(opts.minimumBreakSec || 3.2, cadence * (opts.cadenceMultiplier || 2.2));
    const ranges = [];
    for (const g of Array.isArray(explicit) ? explicit : []) {
      const from = +(g || {}).from, to = +(g || {}).to;
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) ranges.push({ from, to });
    }
    for (let i = 1; i < times.length; i++) {
      const dt = times[i] - times[i - 1];
      if (dt > threshold) {
        // The next expected accepted window is the first missing moment. The
        // row at `times[i]` is real again, so it is the exclusive end.
        ranges.push({ from: times[i - 1] + cadence, to: times[i] });
      }
    }
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range.from <= last.to + Math.max(0.25, cadence * 0.5)) last.to = Math.max(last.to, range.to);
      else merged.push({ from: range.from, to: range.to });
    }
    return {
      cadence,
      threshold,
      gaps: merged.map((g) => ({ from: +g.from.toFixed(2), to: +g.to.toFixed(2) })),
    };
  }

  return { placeRow, pickStripTier, measurementGaps };
});
