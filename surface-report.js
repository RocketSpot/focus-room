/* eslint-disable */
// ============================================================
// surface-report.js, what each screen was ACTUALLY showing.
// ------------------------------------------------------------
// Payload logs prove what the room sent. This small, injected observer proves
// what the page drew: the visible canvas bounds, keyboard/viewport geometry,
// uncovered edges, overflow and text-box collisions. It never reads form values
// or reports guest copy; element identities are tag/id/class only. The one text
// field is the page's short title/headline. Raw EEG is never touched.
// ============================================================
(function () {
  'use strict';
  var last = '';
  var timer = null;
  var settleTimers = [];

  function post(kind, body) {
    try {
      body.kind = kind;
      body.page = location.pathname;
      navigator.sendBeacon('/surface-report', JSON.stringify(body));
    } catch (e) { /* reporting must never break a surface */ }
  }

  function elementName(el) {
    var tag = String((el && el.tagName) || '').toLowerCase();
    var id = el && el.id ? '#' + String(el.id).slice(0, 40) : '';
    var cls = '';
    try {
      var raw = typeof el.className === 'string' ? el.className : '';
      cls = raw ? '.' + raw.trim().split(/\s+/).slice(0, 3).join('.') : '';
    } catch (_) {}
    return (tag + id + cls).slice(0, 90);
  }

  function visible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0;
  }

  function rects(sel) {
    var out = [];
    var nodes = document.querySelectorAll(sel);
    for (var i = 0; i < nodes.length && i < 260; i++) {
      var el = nodes[i];
      if (!visible(el) || !(el.textContent || '').trim()) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push({ el: el, r: r, name: elementName(el) });
    }
    return out;
  }

  // Pairwise is bounded to 260 small text boxes and runs only after a real
  // layout change or the four-second safety poll. Ancestor/descendant boxes are
  // ignored because their overlap is normal containment, not overprinting.
  function overlaps() {
    var items = rects('span, p, h1, h2, h3, div.k, div.v, .lab, .label, li, td, button');
    var hits = [];
    for (var i = 0; i < items.length; i++) {
      for (var j = i + 1; j < items.length; j++) {
        var a = items[i], b = items[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        var ax = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        var ay = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ax > 2 && ay > 2) {
          hits.push({ a: a.name, b: b.name, x: Math.round(ax), y: Math.round(ay) });
          if (hits.length >= 12) return hits;
        }
      }
    }
    return hits;
  }

  function overflowing() {
    var w = window.innerWidth, out = [];
    var nodes = document.querySelectorAll('body *');
    for (var i = 0; i < nodes.length && i < 1200; i++) {
      var el = nodes[i];
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.right > w + 2 || r.left < -2) {
        out.push({ element: elementName(el), left: Math.round(r.left),
          right: Math.round(r.right), viewport: w });
        if (out.length >= 8) break;
      }
    }
    return out;
  }

  function headline() {
    var h = document.querySelector('h1, h2, .headline, .title');
    return h ? (h.textContent || '').trim().slice(0, 80) : '';
  }

  function surfaceTarget() {
    // Document height can be full while the scaled canvas is short inside it,
    // which was the real iPad failure. Measure the actual guest canvas.
    return document.querySelector('body.device .screen')
      || document.getElementById('tv')
      || document.getElementById('stage')
      || document.body;
  }

  function roundedRect(r) {
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right),
      bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function backgroundOf(el) {
    try { return getComputedStyle(el).backgroundColor || null; } catch (_) { return null; }
  }

  function snapshot(why) {
    var de = document.documentElement;
    var vv = window.visualViewport;
    var docH = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
    var docW = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
    var target = surfaceTarget();
    var tr = target.getBoundingClientRect();
    // The software keyboard changes and offsets the VISUAL viewport inside an
    // unchanged layout viewport. Compare the canvas to what is truly visible.
    var view = vv
      ? { left: vv.offsetLeft || 0, top: vv.offsetTop || 0,
          right: (vv.offsetLeft || 0) + vv.width, bottom: (vv.offsetTop || 0) + vv.height }
      : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    var edgeGaps = {
      top: Math.max(0, Math.round(tr.top - view.top)),
      right: Math.max(0, Math.round(view.right - tr.right)),
      bottom: Math.max(0, Math.round(view.bottom - tr.bottom)),
      left: Math.max(0, Math.round(tr.left - view.left)),
    };
    var ov = overlaps();
    var of = overflowing();
    var active = document.activeElement;
    var body = {
      why: why,
      screen: { w: (window.screen || {}).width || null, h: (window.screen || {}).height || null,
        dpr: window.devicePixelRatio || 1, orient: (screen.orientation || {}).type || null },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      visual: vv ? { w: Math.round(vv.width), h: Math.round(vv.height),
        left: Math.round(vv.offsetLeft || 0), top: Math.round(vv.offsetTop || 0),
        scale: +(vv.scale || 1).toFixed(3) } : null,
      doc: { w: docW, h: docH, scrollY: window.scrollY || 0 },
      surface: { element: elementName(target), rect: roundedRect(tr), edgeGaps: edgeGaps },
      grounds: { html: backgroundOf(de), body: backgroundOf(document.body), surface: backgroundOf(target) },
      headline: headline(),
      beat: (document.body && document.body.getAttribute('data-beat')) || null,
      focus: active && active !== document.body
        ? { element: elementName(active), type: active.type || null } : null,
      overlaps: ov,
      overflowing: of,
    };
    // One line per genuine visible change, not per animation frame.
    var key = [body.headline, body.viewport.w, body.viewport.h, body.doc.h,
      edgeGaps.top, edgeGaps.right, edgeGaps.bottom, edgeGaps.left,
      body.focus ? body.focus.element : '', ov.length, of.length,
      body.visual ? body.visual.h + ':' + body.visual.top : ''].join('|');
    if (key === last) return;
    last = key;
    post('screen', body);
  }

  function schedule(why) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { snapshot(why); }, 350);
  }

  function scheduleSettling(why) {
    schedule(why);
    settleTimers.forEach(clearTimeout);
    settleTimers = [120, 420, 850].map(function (ms) {
      return setTimeout(function () { snapshot(why + '-settled'); }, ms);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { schedule('load'); });
  } else { schedule('load'); }
  window.addEventListener('load', function () { schedule('load-complete'); });
  window.addEventListener('resize', function () { scheduleSettling('resize'); });
  window.addEventListener('orientationchange', function () { scheduleSettling('orientation'); });
  window.addEventListener('focusin', function () { scheduleSettling('focus-in'); });
  window.addEventListener('focusout', function () { scheduleSettling('focus-out'); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () { scheduleSettling('visual-viewport'); });
    window.visualViewport.addEventListener('scroll', function () { schedule('visual-scroll'); });
  }
  if (window.MutationObserver) {
    var observer = new MutationObserver(function () { schedule('dom-change'); });
    var observe = function () {
      if (document.body) observer.observe(document.body, { childList: true, subtree: true,
        characterData: true, attributes: true, attributeFilter: ['class', 'style', 'data-beat'] });
    };
    if (document.body) observe();
    else document.addEventListener('DOMContentLoaded', observe, { once: true });
  }
  setInterval(function () { snapshot('poll'); }, 4000);
})();
