'use strict';
// ============================================================
// Card/profile honesty + layout regressions. Runs in Electron because SVG text
// measurement and the generated FocusLine DOM are the behavior under test:
//   npx electron tests/takeaway-visuals.test.js
// Set FOCUSROOM_TAKEAWAY_CAPTURE_DIR to retain invalid-session proof PNGs.
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const CAPTURE_DIR = process.env.FOCUSROOM_TAKEAWAY_CAPTURE_DIR || '';
let failures = 0;

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const timeout = setTimeout(() => {
  console.error('\nTAKEAWAY VISUAL TEST TIMED OUT');
  app.exit(1);
}, 30000);

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(` FAIL  ${name} — ${e.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitRendered(win) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(`JSON.stringify({
      rendered: document.body.getAttribute('data-rendered'),
      error: document.body.getAttribute('data-render-error')
    })`);
    const parsed = JSON.parse(state);
    if (parsed.error) throw new Error(parsed.error);
    if (parsed.rendered === '1') return;
    await sleep(30);
  }
  throw new Error('template did not finish rendering');
}

async function openTemplate(file, data) {
  const isCard = file === 'card.html';
  const win = new BrowserWindow({
    width: isCard ? 520 : 1180,
    height: isCard ? 900 : 1040,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadFile(path.join(ROOT, file), { query: { wait: '1' } });
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  await win.webContents.executeJavaScript(`window.__setData(${json})`);
  await waitRendered(win);
  return win;
}

async function inspect(win) {
  return JSON.parse(await win.webContents.executeJavaScript(`(() => {
    const svg = document.querySelector('svg');
    const name = document.getElementById('slot-archetype');
    const desc = document.getElementById('slot-desc');
    const focus = document.getElementById('focus-line');
    const box = name.getBBox();
    const descBox = desc ? desc.getBBox() : null;
    const svgBox = svg.viewBox.baseVal;
    return JSON.stringify({
      svg: { x: svgBox.x, y: svgBox.y, width: svgBox.width, height: svgBox.height },
      name: { x: box.x, y: box.y, width: box.width, height: box.height,
        lines: Number(name.getAttribute('data-line-count') || 0),
        text: name.getAttribute('aria-label') || name.textContent },
      desc: descBox && { x: descBox.x, y: descBox.y, width: descBox.width, height: descBox.height },
      lineRendered: focus.getAttribute('data-line-rendered'),
      interruptionRendered: focus.getAttribute('data-interruption-rendered'),
      focusPaths: focus.querySelectorAll('[data-role="focus-line"]').length,
      interruptionMarks: focus.querySelectorAll('[data-role="interruption-marker"]').length,
      focusChildren: focus.children.length,
      activeQuadrants: document.querySelectorAll('#quad circle[stroke]').length
    });
  })()`));
}

async function capture(win, name) {
  if (!CAPTURE_DIR) return;
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const rect = JSON.parse(await win.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('svg').getBoundingClientRect();
    return JSON.stringify({ x: Math.floor(r.x), y: Math.floor(r.y),
      width: Math.ceil(r.width), height: Math.ceil(r.height) });
  })()`));
  const image = await win.webContents.capturePage(rect);
  fs.writeFileSync(path.join(CAPTURE_DIR, name), image.toPNG());
}

const invalid = {
  measured: false,
  arch: 'deep',
  name: 'Not measured this session',
  date: '08/31/2026',
  samples: [],
  troughT: null,
  caption: ['The room did not record enough usable signal.', 'No line or notification response was estimated.', 'Nothing here was filled in.'],
  desc: 'The room did not record enough usable signal to draw a focus profile.',
};

const measuredNoTrough = {
  measured: true,
  arch: 'steady',
  name: 'Steady Burner',
  date: '08/31/2026',
  samples: Array.from({ length: 24 }, (_, i) => ({ t: i, v: 0.3 + i / 60 })),
  troughT: null,
  caption: ['A measured session.', 'No notification marker was recorded.', 'The line remains the measured line.'],
  desc: 'Even focus through the measured stretch.',
};

const measuredWithTrough = Object.assign({}, measuredNoTrough, { troughT: 12 });

app.whenReady().then(async () => {
  console.log('\n-- takeaway templates (measured data only, bounded type) --');
  for (const file of ['card.html', 'profile.html']) {
    let win = null;
    try {
      win = await openTemplate(file, invalid);
      const state = await inspect(win);
      check(`${file}: long not-measured name wraps`, () => {
        assert.equal(state.name.lines, 2, JSON.stringify(state.name));
      });
      check(`${file}: wrapped name stays inside the SVG`, () => {
        assert(state.name.x >= state.svg.x - 0.5, JSON.stringify(state.name));
        assert(state.name.x + state.name.width <= state.svg.x + state.svg.width + 0.5,
          JSON.stringify(state.name));
      });
      check(`${file}: invalid payload has no synthetic FocusLine`, () => {
        assert.equal(state.lineRendered, '0');
        assert.equal(state.focusPaths, 0);
        assert.equal(state.focusChildren, 0);
      });
      check(`${file}: invalid payload has no interruption marker`, () => {
        assert.equal(state.interruptionRendered, '0');
        assert.equal(state.interruptionMarks, 0);
      });
      if (file === 'profile.html') {
        check('profile.html: long description also stays on-canvas', () => {
          assert(state.desc.x + state.desc.width <= state.svg.x + state.svg.width + 0.5,
            JSON.stringify(state.desc));
        });
        check('profile.html: invalid payload names no archetype quadrant', () => {
          assert.equal(state.activeQuadrants, 0);
        });
      }
      await capture(win, file.replace('.html', '-not-measured.png'));
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
    }

    try {
      win = await openTemplate(file, measuredNoTrough);
      const state = await inspect(win);
      check(`${file}: measured samples render their FocusLine`, () => {
        assert.equal(state.lineRendered, '1');
        assert(state.focusPaths > 0, JSON.stringify(state));
      });
      check(`${file}: missing trough never invents an interruption`, () => {
        assert.equal(state.interruptionRendered, '0');
        assert.equal(state.interruptionMarks, 0);
      });
      await capture(win, file.replace('.html', '-measured-no-trough.png'));
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
    }

    try {
      win = await openTemplate(file, measuredWithTrough);
      const state = await inspect(win);
      check(`${file}: a recorded trough renders the marker`, () => {
        assert.equal(state.interruptionRendered, '1');
        assert(state.interruptionMarks > 0, JSON.stringify(state));
      });
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
    }
  }

  clearTimeout(timeout);
  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}\n`);
  app.exit(failures === 0 ? 0 : 1);
}).catch((e) => {
  clearTimeout(timeout);
  console.error(e.stack || e.message);
  app.exit(1);
});
