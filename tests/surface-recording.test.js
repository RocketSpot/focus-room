'use strict';
// ============================================================
// tests/surface-recording.test.js: every guest-facing surface leaves a useful,
// privacy-safe visual record.
//
// There are three layers here because each catches a different regression:
//   1. execute the injected browser observer in a tiny DOM and inspect its
//      beacon (geometry is relative to the *visual* viewport; guest input is
//      absent);
//   2. exercise the real HTTP server to prove every HTML page receives the
//      observer and reports reach room-core;
//   3. boot app/main.js against an Electron double to prove the physical TV
//      writes lossless, post-paint PNGs for beats and every within-page reveal.
//
// No screenshot or report in this test contains real guest data.
//   node tests/surface-recording.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const reporterSource = fs.readFileSync(path.join(ROOT, 'surface-report.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'app', 'server.js'), 'utf8');
const stageSource = fs.readFileSync(path.join(ROOT, 'build', 'stage-webroot.js'), 'utf8');

let passed = 0;
const failures = [];
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name);
    console.error(' FAIL  ' + name + '\n       ' + e.message);
  }
}

function rect(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function element(tag, id, className, bounds, text) {
  return {
    tagName: tag.toUpperCase(), id: id || '', className: className || '',
    textContent: text || '', type: null, value: null, _bounds: bounds,
    getClientRects() { return [this._bounds]; },
    getBoundingClientRect() { return this._bounds; },
    contains() { return false; },
    getAttribute() { return null; },
  };
}

function runReporter() {
  const beacons = [];
  const timers = [];
  const listeners = {};
  const vvListeners = {};
  const target = element('main', 'guest-canvas', 'screen field', rect(20, 300, 800, 1100));
  const heading = element('h1', 'page-title', 'headline', rect(40, 320, 500, 380), 'Known screen title');
  const secretCopy = element('p', 'guest-copy', 'answer', rect(40, 400, 500, 450), 'ARBITRARY GUEST THOUGHT 91A');
  const overlap = element('p', 'other-copy', 'copy', rect(450, 420, 720, 470), 'private body copy');
  const active = element('input', 'email', 'guest-input', rect(40, 800, 500, 850));
  active.type = 'email';
  active.value = 'secret-person@example.test';
  const body = element('body', '', 'device', rect(0, 0, 820, 1180));
  body.scrollHeight = 1180; body.scrollWidth = 820;
  body.getAttribute = (name) => name === 'data-beat' ? 'email' : null;
  const html = element('html', '', '', rect(0, 0, 820, 1180));
  html.scrollHeight = 1180; html.scrollWidth = 820;
  const document = {
    readyState: 'complete', body, documentElement: html, activeElement: active,
    querySelector(sel) {
      if (sel === 'body.device .screen') return target;
      if (sel === 'h1, h2, .headline, .title') return heading;
      return null;
    },
    getElementById() { return null; },
    // The two text nodes deliberately contain private copy. The reporter may
    // use their geometry and identity, never their text.
    querySelectorAll(sel) {
      if (sel.indexOf('span, p') === 0) return [secretCopy, overlap];
      if (sel === 'body *') return [target, heading, secretCopy, overlap, active];
      return [];
    },
    addEventListener() {},
  };
  const visualViewport = {
    width: 800, height: 900, offsetLeft: 10, offsetTop: 280, scale: 1,
    addEventListener(type, fn) { vvListeners[type] = fn; },
  };
  const screen = { width: 820, height: 1180, orientation: { type: 'portrait-primary' } };
  const window = {
    innerWidth: 820, innerHeight: 1180, visualViewport, screen,
    devicePixelRatio: 2, scrollY: 0,
    addEventListener(type, fn) { listeners[type] = fn; },
  };
  const sandbox = {
    window, document, screen, location: { pathname: '/ipad-flow.html' },
    navigator: { sendBeacon(url, data) { beacons.push({ url, data }); return true; } },
    getComputedStyle(el) {
      const ground = el === html ? 'rgb(239, 234, 227)'
        : el === body || el === target ? 'rgb(15, 15, 14)' : 'rgba(0, 0, 0, 0)';
      return { visibility: 'visible', display: 'block', opacity: '1', backgroundColor: ground };
    },
    setTimeout(fn, ms) { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    clearTimeout(t) { if (t) t.cancelled = true; },
    setInterval() { return 1; },
    clearInterval() {},
    console,
  };
  vm.runInNewContext(reporterSource, sandbox, { filename: 'surface-report.js' });
  // Drain only timers that exist at this point. snapshot() does not enqueue
  // more work, and the four-second interval is intentionally inert in the test.
  for (const t of timers.slice()) if (!t.cancelled) t.fn();
  assert.strictEqual(beacons.length, 1, 'expected one initial screen beacon');
  return { url: beacons[0].url, payload: JSON.parse(beacons[0].data), listeners, vvListeners };
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function waitFor(predicate, message, timeoutMs = 1200) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(message));
      setTimeout(poll, 5);
    };
    poll();
  });
}

async function exerciseMainCapture() {
  let hooks = null;
  const writes = [];
  const diags = [];
  const paintScripts = [];
  const windows = [];
  let pngCalls = 0;
  let jpegCalls = 0;

  class FakeWebContents {
    constructor(owner) { this.owner = owner; this.url = ''; this.handlers = {}; }
    send() {}
    isDestroyed() { return false; }
    setWindowOpenHandler() {}
    on(type, fn) { this.handlers[type] = fn; }
    getURL() { return this.url; }
    executeJavaScript(source) { paintScripts.push(source); return Promise.resolve(); }
    capturePage() {
      return Promise.resolve({
        toPNG() { pngCalls += 1; return Buffer.from('LOSSLESS-PNG'); },
        toJPEG() { jpegCalls += 1; return Buffer.from('LOSSY-JPEG'); },
        getSize() { return { width: 1920, height: 1080 }; },
      });
    }
  }
  class FakeWindow {
    constructor(options) {
      this.options = options; this.webContents = new FakeWebContents(this);
      this.handlers = {}; windows.push(this);
    }
    isDestroyed() { return false; }
    loadURL(url) {
      this.webContents.url = url;
      const nav = this.webContents.handlers['did-navigate'];
      if (nav) nav({}, url);
      return Promise.resolve();
    }
    once(type, fn) { this.handlers[type] = fn; if (type === 'ready-to-show') fn(); }
    on(type, fn) { this.handlers[type] = fn; }
    show() {}
    close() {}
    setFullScreen() {}
    isFullScreen() { return true; }
    isMinimized() { return false; }
    restore() {}
    focus() {}
  }
  FakeWindow.getAllWindows = () => windows;

  const appHandlers = {};
  const app = {
    isPackaged: false, commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true, quit() {}, exit() {}, relaunch() {},
    getVersion: () => 'test', setAboutPanelOptions() {},
    whenReady() { return Promise.resolve(); },
    on(type, fn) { appHandlers[type] = fn; },
  };
  const orchestrator = { beat: 'idle' };
  const server = {
    configureRawAuth() {}, lanUrls: () => [],
  };
  const supervisor = { info: {}, send: () => true, start: () => Promise.resolve() };
  const room = {
    supervisor, server, orchestrator,
    pushDiag(type, payload) { diags.push({ type, payload }); },
    banner() {}, wireSidecar() {}, wireSurfaces() {}, startServerWithRetry() {},
    cleanup(fn) { return Promise.resolve().then(fn); }, attachCrashGuard() {},
  };
  const fsDouble = {
    mkdirSync() {},
    promises: { writeFile(file, bytes) { writes.push({ file, bytes }); return Promise.resolve(); } },
  };
  const processDouble = {
    env: { FOCUSROOM_NO_AUDIO: '1', FOCUSROOM_WINDOWED: '1', FOCUSROOM_NO_QUICKSTART: '0' },
    platform: 'linux', argv: [], resourcesPath: ROOT,
    on() {}, exit() {},
  };
  const electron = {
    app, BrowserWindow: FakeWindow,
    screen: {
      getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    globalShortcut: { register: () => true, unregisterAll() {} },
    ipcMain: { handle() {} }, shell: { openExternal: () => Promise.resolve() },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (x) => x },
  };
  const requireDouble = (id) => {
    if (id === 'electron') return electron;
    if (id === 'path') return path;
    if (id === 'fs') return fsDouble;
    if (id === 'crypto') return require('crypto');
    if (id === 'child_process') return { execFile() {} };
    if (id === './config') return {
      dataDir: '/private/test-data', isDev: true, isPackaged: false, repoRoot: ROOT,
      RAW_REQUIRE_LOOPBACK: true, net: { LAN_PORT: 4321 },
    };
    if (id === './room-core') return { createRoom(options) { hooks = options; return room; } };
    if (id === './protocol') return { SIDECAR_IN: { TEST: 'test_signal' } };
    if (id === './update-check.js') return { checkForUpdate() {} };
    throw new Error('unexpected require in main test: ' + id);
  };
  vm.runInNewContext(mainSource, {
    require: requireDouble, module: { exports: {} }, exports: {}, __dirname: path.join(ROOT, 'app'),
    process: processDouble, Buffer, console, setTimeout, clearTimeout,
  }, { filename: 'app/main.js' });

  await waitFor(() => windows.length === 1, 'the TV window was not created');
  assert.ok(hooks && hooks.onBeat && hooks.onDiag, 'room hooks were not installed');

  async function expectOneCapture(action, why) {
    const before = writes.length;
    action();
    await waitFor(() => writes.length === before + 1, 'capture missing for ' + why);
    assert.ok(writes[writes.length - 1].file.includes(why),
      `expected ${why} in ${writes[writes.length - 1].file}`);
  }

  orchestrator.beat = 'fit';
  await expectOneCapture(() => hooks.onBeat({ surface: 'signal', beat: 'fit' }), 'beat-fit');
  orchestrator.beat = 'standby';
  await expectOneCapture(() => hooks.onBeat({ surface: 'reveal', beat: 'standby' }), 'beat-standby');
  await expectOneCapture(() => hooks.onDiag('room:out', { type: 'reveal/data', payload: {} }),
    'event-reveal-data');
  for (let index = 0; index < 4; index += 1) {
    await expectOneCapture(() => hooks.onDiag('room:out', {
      type: 'reveal/step', payload: { index },
    }), 'event-reveal-step-' + index);
  }
  await expectOneCapture(() => hooks.onDiag('room:out', {
    type: 'interruption/fire', payload: {},
  }), 'event-interruption-fire');
  await expectOneCapture(() => hooks.onDiag('room:out', {
    type: 'constellation/join', payload: {},
  }), 'event-constellation-join');

  return { writes, diags, paintScripts, pngCalls, jpegCalls };
}

(async () => {
  console.log('\n-- injected observer behavior --');
  const report = runReporter();
  ok('the observer posts only to the local surface-report endpoint', () => {
    assert.strictEqual(report.url, '/surface-report');
    assert.strictEqual(report.payload.page, '/ipad-flow.html');
  });
  ok('unfilled edges are measured against visualViewport offsets', () => {
    assert.deepStrictEqual({ ...report.payload.surface.edgeGaps },
      { top: 20, right: 10, bottom: 80, left: 10 });
    assert.deepStrictEqual({ ...report.payload.visual },
      { w: 800, h: 900, left: 10, top: 280, scale: 1 });
  });
  ok('the report identifies focus without copying the form value', () => {
    assert.deepStrictEqual({ ...report.payload.focus },
      { element: 'input#email.guest-input', type: 'email' });
    const raw = JSON.stringify(report.payload);
    assert.ok(!raw.includes('secret-person@example.test'), raw);
  });
  ok('overlap evidence contains element identities and geometry, never arbitrary copy', () => {
    assert.strictEqual(report.payload.overlaps.length, 1);
    const raw = JSON.stringify(report.payload);
    assert.ok(!raw.includes('ARBITRARY GUEST THOUGHT 91A'), raw);
    assert.ok(!raw.includes('private body copy'), raw);
    assert.deepStrictEqual({ ...report.payload.overlaps[0] },
      { a: 'p#guest-copy.answer', b: 'p#other-copy.copy', x: 50, y: 30 });
  });
  ok('the report records canvas bounds, page ground, beat, and orientation', () => {
    assert.strictEqual(report.payload.surface.element, 'main#guest-canvas.screen.field');
    assert.strictEqual(report.payload.surface.rect.h, 800);
    assert.strictEqual(report.payload.beat, 'email');
    assert.strictEqual(report.payload.screen.orient, 'portrait-primary');
    assert.strictEqual(report.payload.grounds.html, 'rgb(239, 234, 227)');
  });
  ok('keyboard and orientation geometry channels are observed', () => {
    assert.ok(report.listeners.resize && report.listeners.orientationchange);
    assert.ok(report.listeners.focusin && report.listeners.focusout);
    assert.ok(report.vvListeners.resize && report.vvListeners.scroll);
  });

  console.log('\n-- real surface server wiring --');
  process.env.FOCUSROOM_LAN_PORT = '47483';
  // Require only after selecting the port: config reads it at module load.
  const { SurfaceServer } = require(path.join(ROOT, 'app', 'server.js'));
  const surfaceServer = new SurfaceServer();
  let relayed = null;
  surfaceServer.on('surface-report', (body) => { relayed = body; });
  await surfaceServer.start();
  try {
    const html = await request(47483, '/index.html');
    ok('every served HTML page receives exactly one deferred observer', () => {
      assert.strictEqual(html.status, 200);
      assert.strictEqual((html.body.match(/<script src="\/surface-report\.js" defer><\/script>/g) || []).length, 1);
      assert.ok(html.body.indexOf('/surface-report.js') < html.body.indexOf('</head>'));
      assert.strictEqual(Number(html.headers['content-length']), Buffer.byteLength(html.body));
    });
    const js = await request(47483, '/surface-report.js');
    ok('the observer itself is served as JavaScript', () => {
      assert.strictEqual(js.status, 200);
      assert.match(js.headers['content-type'], /^text\/javascript/);
      assert.ok(js.body.includes("post('screen', body)"));
    });
    const body = JSON.stringify({ kind: 'screen', page: '/tv-reveal.html',
      surface: { edgeGaps: { top: 0, right: 0, bottom: 0, left: 0 } } });
    const posted = await request(47483, '/surface-report', {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    ok('a surface beacon is accepted and emitted to room-core', () => {
      assert.strictEqual(posted.status, 204);
      assert.deepStrictEqual(relayed, JSON.parse(body));
    });
    relayed = null;
    const oversizedBody = JSON.stringify({ kind: 'screen', page: '/ipad-flow.html',
      padding: 'x'.repeat(40000) });
    const oversized = await request(47483, '/surface-report', {
      method: 'POST', body: oversizedBody,
      headers: { 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(oversizedBody) },
    });
    ok('an oversized beacon is drained but never parsed or relayed', () => {
      assert.strictEqual(oversized.status, 204);
      assert.strictEqual(relayed, null);
    });
  } finally {
    await surfaceServer.stop();
  }

  console.log('\n-- physical TV capture behavior --');
  const capture = await exerciseMainCapture();
  ok('each capture waits for two paint frames plus a settling interval', () => {
    assert.ok(capture.paintScripts.length >= capture.writes.length);
    for (const source of capture.paintScripts) {
      assert.strictEqual((source.match(/requestAnimationFrame/g) || []).length, 2, source);
      assert.ok(/setTimeout\(resolve,\s*420\)/.test(source), source);
    }
  });
  ok('every proof image is a lossless PNG', () => {
    assert.strictEqual(capture.pngCalls, capture.writes.length);
    assert.strictEqual(capture.jpegCalls, 0);
    assert.ok(capture.writes.every((w) => w.file.endsWith('.png')));
    assert.ok(capture.writes.every((w) => w.bytes.toString() === 'LOSSLESS-PNG'));
  });
  ok('the trail covers beat navigation, reveal data and all four reveal steps', () => {
    const names = capture.writes.map((w) => path.basename(w.file));
    for (const token of ['beat-fit', 'beat-standby', 'event-reveal-data',
      'event-reveal-step-0', 'event-reveal-step-1', 'event-reveal-step-2', 'event-reveal-step-3']) {
      assert.ok(names.some((n) => n.includes(token)), token + ' missing from ' + names.join(', '));
    }
  });
  ok('the interruption and constellation landing each get a proof image', () => {
    const names = capture.writes.map((w) => path.basename(w.file));
    assert.ok(names.some((n) => n.includes('event-interruption-fire')));
    assert.ok(names.some((n) => n.includes('event-constellation-join')));
  });
  ok('capture trail entries include actual URL, size, beat, and basename only', () => {
    const entries = capture.diags.filter((d) => d.type === 'surface:capture');
    assert.strictEqual(entries.length, capture.writes.length);
    assert.ok(entries.every((e) => /^http:\/\/127\.0\.0\.1:4321\//.test(e.payload.actualUrl)));
    assert.ok(entries.every((e) => e.payload.size.width === 1920 && e.payload.size.height === 1080));
    assert.ok(entries.every((e) => !e.payload.file.includes('/')));
  });

  console.log('\n-- source/package invariants --');
  ok('stale beat and stale surface guards prevent mislabeled screenshots', () => {
    assert.ok(/options\.expectedBeat[\s\S]*orchestrator\.beat !== options\.expectedBeat/.test(mainSource));
    assert.ok(/options\.expectedSurface[\s\S]*actualUrl\.indexOf\('\/tv-'/.test(mainSource));
    assert.ok(/surface:capture-skipped/.test(mainSource));
  });
  ok('the packaged webroot includes the injected observer', () => {
    assert.ok(/['"]surface-report\.js['"]/.test(stageSource));
  });
  ok('the server exposes a bounded dedicated report route and injects before content length', () => {
    assert.ok(/pathname === '\/surface-report'/.test(serverSource));
    assert.ok(/const limit = 32768/.test(serverSource));
    assert.ok(/if \(!tooLarge\)/.test(serverSource));
    const injectAt = serverSource.indexOf("const tag = '<script src=\"/surface-report.js\"");
    const lengthAt = serverSource.indexOf("headers['Content-Length'] = String(buf.length)", injectAt);
    assert.ok(injectAt > -1 && lengthAt > injectAt);
  });

  console.log('\n' + (failures.length ? `${failures.length} FAILURE(S)` : `all ${passed} checks passed`));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  process.exit(1);
});
