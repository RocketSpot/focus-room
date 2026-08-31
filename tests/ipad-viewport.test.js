'use strict';
// ============================================================
// tests/ipad-viewport.test.js: the guest iPad must fill the display, always.
//
// A real session on a real iPad showed the shell through the app: a black band
// across the top the moment the on-mind textarea took the keyboard, a black band
// across the bottom once the keyboard left, and the same band still there on the
// closing screen with no keyboard involved. Every one of those was the guest
// canvas being sized from the VISUAL viewport and centred over the LAYOUT one,
// against a near-black page background.
//
// These are source assertions, deliberately. The failure only reproduces inside
// real iPadOS Safari with a real software keyboard, which no headless runner
// has, so what is pinned here is the shape of the fix: the declarations and the
// measurement source that make the band impossible.
//   node tests/ipad-viewport.test.js
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
const shell = fs.readFileSync(path.join(ROOT, 'ipad-flow.html'), 'utf8');
const controller = fs.readFileSync(path.join(ROOT, 'ipad', 'controller.jsx'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'ipad', 'ui.jsx'), 'utf8');

// the comments in this repo name the failure they prevent, so they quote the very
// APIs the code must not call. Strip them before asserting on what the code does.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = stripComments(controller);

// a function body: from its declaration to the next top-level one in the file
function bodyOf(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at > -1, name + ' not found');
  const rest = src.slice(at + 1);
  const next = rest.search(/\n {2}function \w+\s*\(/);
  return rest.slice(0, next > -1 ? next : rest.length);
}

// ---------- the shell ----------

ok('the viewport meta covers the notch and declares the keyboard behaviour', () => {
  const m = shell.match(/<meta name="viewport" content="([^"]+)"/);
  assert.ok(m, 'no viewport meta');
  assert.ok(/viewport-fit=cover/.test(m[1]), 'viewport-fit=cover missing, the canvas cannot reach the edges');
  assert.ok(/interactive-widget=resizes-content/.test(m[1]),
    'interactive-widget=resizes-content missing, the keyboard is free to shrink the visual viewport out from under a fixed app root');
});

ok('the shell measures itself in dvh, never bare vh', () => {
  assert.ok(/height:\s*100dvh/.test(shell), 'no 100dvh in the shell');
  assert.ok(!/height:\s*100vh/.test(shell),
    '100vh is the TALL viewport on iPadOS: with Safari bars showing it measures taller than the display');
});

ok('the page ground is the room field colour, never black', () => {
  assert.ok(/html\.device[^{]*\{[^}]*var\(--room-ground/.test(shell),
    'the <html> element must paint --room-ground; no body.device selector can reach it');
  assert.ok(/body\.device\s+#stage\s*\{[^}]*var\(--room-ground/.test(shell),
    '#stage must paint --room-ground in device mode');
  assert.ok(!/body\.device\s+#stage\s*\{\s*background:\s*#060605/.test(shell),
    'the near-black stage ground is what a guest saw as the band');
});

ok('the device body cannot be scrolled out from under the guest', () => {
  assert.ok(/body\.device\s*\{[^}]*position:\s*fixed/.test(shell),
    'a scrollable body lets iOS drag the room off the top to reveal a focused input');
  assert.ok(/overscroll-behavior:\s*none/.test(shell), 'rubber-band drag peels the app off the screen');
});

ok('the dead body.device html selector is gone', () => {
  assert.ok(!/body\.device\s+html/.test(shell),
    'html is never a descendant of body, so that rule never applied and the root kept its 100%');
});

ok('the full-cover overlays respect the safe-area insets', () => {
  assert.ok(/#rotate[\s\S]{0,900}env\(safe-area-inset-top\)/.test(shell),
    'viewport-fit=cover puts the rotate overlay under the status bar');
});

// ---------- the canvas scaler ----------

ok('the canvas is sized from the layout viewport, not the visual one', () => {
  assert.ok(/function layoutBox\s*\(/.test(code), 'layoutBox() missing');
  assert.ok(/getBoundingClientRect/.test(code),
    'the scaler must measure #stage, the box it is actually filling');
  // the keyboard shrinks the visual viewport, and a canvas that shrinks with it
  // is exactly the band the guest saw
  assert.ok(!/visualViewport\.height/.test(code),
    'no geometry in the controller may come from visualViewport.height');
});

ok('the canvas never rounds down into a hairline of shell', () => {
  const fit = bodyOf(code, 'fit');
  assert.ok(/Math\.ceil\(box\.w \/ s\)/.test(fit) && /Math\.ceil\(box\.h \/ s\)/.test(fit),
    'the canvas must overshoot the viewport, never undershoot it');
  assert.ok(!/Math\.floor/.test(fit), 'floor leaves an exposed edge after the scale');
});

ok('the room re-anchors when iOS offsets the visual viewport', () => {
  const anchor = bodyOf(code, 'anchor');
  assert.ok(/visualViewport/.test(anchor) && /offsetTop/.test(anchor),
    'the reveal-the-input offset is what drags the room off the top');
  assert.ok(/window\.scrollTo\(0,\s*0\)/.test(anchor), 'the document scroll must be undone');
});

ok('every channel that can move the viewport triggers a re-measure', () => {
  for (const ev of ['resize', 'orientationchange', 'pageshow', 'focusin', 'focusout']) {
    assert.ok(new RegExp("addEventListener\\('" + ev + "'").test(controller), ev + ' listener missing');
  }
  assert.ok(/visualViewport\.addEventListener\('resize'/.test(controller));
  assert.ok(/visualViewport\.addEventListener\('scroll'/.test(controller));
});

ok('a late iPadOS geometry report cannot leave the canvas short', () => {
  assert.ok(/SETTLE_MS\s*=\s*\[/.test(controller), 'no settle re-measure');
  assert.ok(/function relayoutSettling/.test(controller));
  assert.ok(/'focusout', relayoutSettling/.test(code),
    'focusout must take the settling path, it is the keyboard leaving');
  assert.ok(/'orientationchange', relayoutSettling/.test(code),
    'orientationchange must take the settling path, iPadOS reports the new box late');
});

ok('orientation is judged on the layout box, not the keyboard-shrunk one', () => {
  const watch = bodyOf(code, 'watchOrientation');
  assert.ok(/layoutBox\(\)/.test(watch),
    'a portrait iPad with the keyboard up has a visual viewport wider than it is tall');
  assert.ok(!/visualViewport\.height/.test(watch));
});

// ---------- the ground follows the live screen ----------

ok('both fields publish their ground colour to the shell', () => {
  assert.ok(/function useRoomGround/.test(ui), 'useRoomGround missing');
  assert.ok(/--room-ground/.test(ui), 'the fields must set --room-ground');
  const dark = ui.slice(ui.indexOf('function DarkField'), ui.indexOf('function LightField'));
  const light = ui.slice(ui.indexOf('function LightField'));
  assert.ok(/useRoomGround\('#0F0F0E'\)/.test(dark), 'DarkField does not publish its ground');
  assert.ok(/useRoomGround\('#EFEAE3'\)/.test(light), 'LightField does not publish its ground');
});

ok('every guest screen sits on one of the two fields', () => {
  const s1 = fs.readFileSync(path.join(ROOT, 'ipad', 'screens1.jsx'), 'utf8');
  const s2 = fs.readFileSync(path.join(ROOT, 'ipad', 'screens2.jsx'), 'utf8');
  const src = s1 + s2;
  for (const name of ['Welcome', 'FitCheck', 'Intake', 'Picker', 'Reading', 'StrongestQ', 'Standby', 'Email', 'Close']) {
    // the field is the screen's own root; without one that screen sets no ground
    assert.ok(/e\((Light|Dark)Field/.test(bodyOf(src, name)),
      name + ' does not render a field, so it publishes no ground');
  }
});

// ---------- house style ----------

ok('no em dashes in the surfaces this fix touched', () => {
  assert.ok(!/—/.test(controller), 'em dash in ipad/controller.jsx');
  assert.ok(!/—/.test(ui), 'em dash in ipad/ui.jsx');
});

console.log('\n' + (fails.length ? `${fails.length} FAILURE(S)` : `all ${pass} checks passed`));
process.exit(fails.length ? 1 : 0);
