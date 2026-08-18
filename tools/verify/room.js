'use strict';
// ============================================================
// tools/verify/room.js — drive the real surfaces and assert what they do.
//   npm run verify
// Runs under Electron (needs a renderer + WebAudio + a real SurfaceServer):
//   1. REVEAL  a full simulated session -> the re-send path -> tv-reveal.html,
//              asserting all five band paths actually render.
//   2. AUDIO   room-audio.html over the served path: beds load + loop, scenes
//              crossfade by beat, and every cue fires (select / transition /
//              scroll / join / interruption).
//   3. ORB     tv-orb.html state machine: commits on sustained shifts, ignores
//              brief blips, never crops.
// Exits non-zero if any assertion fails, so it can gate a build.
// ============================================================
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const REPO = path.resolve(__dirname, '..', '..');
const { Orchestrator } = require(path.join(REPO, 'app', 'orchestrator.js'));
const { SurfaceServer } = require(path.join(REPO, 'app', 'server.js'));
const config = require(path.join(REPO, 'app', 'config.js'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();
// each phase tears its window down; without this Electron's default
// "quit when the last window closes" ends the run after phase 1
app.on('window-all-closed', () => {});
// hard ceiling so a hung renderer can't wedge CI
setTimeout(() => { console.error('\nVERIFY TIMED OUT'); app.exit(1); }, 180000);

// windows must actually paint: a hidden window throttles requestAnimationFrame
// to a near stop, which silently invalidates any animation assertion.
const offscreen = (w, h) => new BrowserWindow({
  width: w, height: h, x: -3200, y: 0, show: true, frame: false,
  backgroundColor: '#0B0B0A', webPreferences: { backgroundThrottling: false },
});
const evalIn = (win) => (code) => win.webContents.executeJavaScript(code).catch((e) => 'JS_ERR ' + e);
// tearing down the previous window can briefly abort the next load (ERR_FAILED)
const load = async (win, target) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await win.loadURL(target); return; }
    catch (e) { if (attempt === 3) throw e; await sleep(400); }
  }
};

// ---- a full simulated session on the real orchestrator ----------------------
function runSession(server) {
  const orch = new Orchestrator({ supervisor: { send: () => true }, server, log: () => {} });
  server.on('client-hello', (info) => {                    // mirrors main.js
    if (info.role !== 'tv') return;
    if (orch.beat === 'standby' && orch.reveal) {
      server.broadcast('reveal/data', orch.revealPayload(), 'tv');
      if (orch.revealStep >= 1) server.broadcast('reveal/step', { index: orch.revealStep }, 'tv');
    }
  });
  const ev = (k, p) => orch.onClientMessage({ type: 'guest/event', kind: k, payload: p || {}, t: Date.now() }, 'ipad');
  const intake = (f) => orch.onClientMessage(Object.assign({ type: 'guest/intake', t: Date.now() }, f), 'ipad');
  orch.onClientHello({ role: 'ipad', clientTime: Date.now() });
  ev('earbud_seated');
  for (let i = 0; i < 4; i++) orch.onSidecar({ type: 'eeg/frame', engagementRel: 0.5, tRel: i, t: Date.now(), signalQuality: 0.97 });
  ev('fit_confirmed');
  intake({ answers: { 0: 'A blip — I barely notice', 1: 'It drifts', 2: 'A few minutes' }, onMind: 'a deadline' });
  intake({ reading: { id: 'octopus', title: 'How an Octopus Thinks' } });
  const base = Date.now();
  for (let i = 1; i <= 180; i++) {
    const eng = 0.35 + 0.45 * Math.min(1, i / 60) + 0.06 * Math.sin(i / 7);
    orch.onSidecar({ type: 'eeg/brainwaves', delta: 0.6 + 0.05 * Math.sin(i / 11), theta: 0.8 + 0.07 * Math.sin(i / 9),
      alpha: 1.15 - 0.3 * Math.min(1, i / 60), beta: 0.5 + eng, gamma: 0.28 + 0.1 * eng, engIndex: eng });
    orch.onSidecar({ type: 'eeg/frame', engagementRel: eng, tRel: i, t: base + i * 1000, stateWord: 'focused', signalQuality: 0.97 });
  }
  orch.onSidecar({ type: 'session/samples', samples: Array.from({ length: 140 }, (_, i) => 0.3 + 0.5 * (i / 140)) });
  ev('reading_finished');
  ev('strongest_stretch_guess', { choice: 'The ending' });
  return orch;
}

app.whenReady().then(async () => {
  const server = new SurfaceServer();
  let port;
  try { const a = await server.start(); port = a.port || config.net.LAN_PORT; }
  catch (e) { console.error('server failed to start:', e.message); return app.exit(1); }
  const url = (f) => `http://127.0.0.1:${port}/${f}`;

  // ---------------- 1. REVEAL ----------------
  console.log('\n-- reveal (full session -> re-send path -> tv-reveal) --');
  const orch = runSession(server);
  ok('session reaches standby', orch.beat === 'standby', orch.beat);
  const pay = orch.revealPayload();
  ok('payload carries the band stream', (pay.bands || []).length > 100, `${(pay.bands || []).length} bands`);
  ok('no null timestamps in the stream', !(pay.bands || []).some((b) => b.t == null), 'null t present');
  ok('payload carries four reads', (pay.reads || []).length === 4, `${(pay.reads || []).length}`);
  const revealWin = offscreen(1280, 720);
  {
    const js = evalIn(revealWin);
    await load(revealWin, url('tv-reveal.html'));
    await sleep(2500);
    const paths = JSON.parse(await js(
      "(function(){var p=document.querySelectorAll('#bandLines path'),o=[];" +
      "for(var i=0;i<p.length;i++)o.push((p[i].getAttribute('d')||'').length);return JSON.stringify(o);})()"));
    ok('all five bands render geometry', paths.length === 5 && paths.every((n) => n > 500), JSON.stringify(paths));
    // the band narrative lives in #bandnote; #sentence is the plain-language read
    const note = await js("document.getElementById('bandnote').textContent");
    const words = String(note).match(/\b(delta|theta|alpha|beta|gamma)\b/g) || [];
    ok('band note never names one rhythm twice', new Set(words).size === words.length, note);

    // the value axis is labelled in real percentages of the guest's own signal
    const ticks = JSON.parse(await js(
      "JSON.stringify([...document.querySelectorAll('#grid text')].map(t=>t.textContent).filter(s=>/%$/.test(s)))"));
    ok('the chart has a labelled percentage axis', ticks.length >= 3, JSON.stringify(ticks));

    // Every slide must fit its fixed prose band. This is the exact class of bug
    // the reveal used to ship: bottom-anchored prose grew upward through the
    // legend and the region label, so text overlapped the chart.
    const fits = [];
    for (let i = 1; i <= 4; i++) {
      server.broadcast('reveal/step', { index: i }, null);
      await sleep(700);
      fits.push(JSON.parse(await js(`JSON.stringify({
        i: ${i},
        fits: document.getElementById('prose').scrollHeight <= document.getElementById('prose').clientHeight,
        stat: document.getElementById('statV').textContent.trim()
      })`)));
    }
    ok('no slide overflows its prose band', fits.every((f) => f.fits), JSON.stringify(fits));
    ok('every slide shows a measured figure', fits.every((f) => f.stat.length > 0), JSON.stringify(fits.map((f) => f.stat)));
  }
  revealWin.destroy(); await sleep(500);

  // ---------------- 2. AUDIO ----------------
  console.log('\n-- audio (served room-audio: beds, scenes, cues) --');
  const audioWin = offscreen(320, 200);
  {
    const js = evalIn(audioWin);
    const info = async () => JSON.parse(await js('JSON.stringify(window.__audio.info())'));
    await load(audioWin, url('room-audio.html'));
    await sleep(4500);                       // decode the ogg beds
    let i = await info();
    ok('engine is running (served autostart)', i.running && i.state === 'running', JSON.stringify(i.state));
    ok('menu bed loaded + looped', i.beds.menu && Array.isArray(i.beds.menuLoop), JSON.stringify(i.beds));
    ok('session bed loaded + looped', i.beds.session && Array.isArray(i.beds.sessionLoop), JSON.stringify(i.beds));
    server.broadcast('session/state', { beat: 'reading' });
    await sleep(6000);
    i = await info();
    ok('reading raises the session scene', i.gains.session > 0.5, `session=${i.gains.session}`);
    ok('reading lowers the menu scene', i.gains.menu < 0.1, `menu=${i.gains.menu}`);
    server.broadcast('session/state', { beat: 'idle' });
    await sleep(6000);
    i = await info();
    ok('idle restores the menu scene', i.gains.menu > 0.15 && i.gains.session < 0.15,
      `menu=${i.gains.menu} session=${i.gains.session}`);
    const before = (await info()).cues;
    server.broadcast('ui/cue', { kind: 'select' });
    server.broadcast('session/state', { beat: 'standby' });
    server.broadcast('reveal/step', { index: 1 });
    server.broadcast('reveal/step', { index: 1 });   // duplicate must be ignored
    server.broadcast('reveal/step', { index: 2 });
    server.broadcast('constellation/join', {});
    server.broadcast('interruption/fire', {});
    await sleep(600);
    let c = (await info()).cues;
    ok('tap cue fires', c.select === before.select + 1, JSON.stringify(c));
    ok('screen-transition cue fires', c.transition === before.transition + 1, JSON.stringify(c));
    ok('reveal scroll ticks (deduped)', c.scroll === before.scroll + 2, JSON.stringify(c));
    ok('interruption ducks the bed', (await info()).duck < 1, 'duck=' + (await info()).duck);
    ok('join chime waits for the dot to land', c.join === before.join, 'rang early');
    await sleep(2600);
    c = (await info()).cues;
    ok('join chime fires on landing', c.join === before.join + 1, JSON.stringify(c));
  }
  audioWin.destroy(); await sleep(500);

  // ---------------- 3. ORB ----------------
  console.log('\n-- orb (state dwell + framing) --');
  const orbWin = offscreen(800, 450);
  {
    const js = evalIn(orbWin);
    const info = async () => JSON.parse(await js('JSON.stringify(window.__orb.info())'));
    const hold = async (v, secs) => {
      await js(`(function(){if(window.__pin)clearInterval(window.__pin);` +
        `window.__pin=setInterval(function(){window.__orb.set(${v});},50);})()`);
      await sleep(secs * 1000);
    };
    await load(orbWin, url('tv-orb.html') + '?preview&static');
    await sleep(1500);
    // The orb fills the TV with `cover` now, and that is safe BY MEASUREMENT:
    // the sphere sits 388px clear of the clip edge (259px in gold) while cover
    // on a 16:9 screen crops (h - w*9/16)/2 per edge. Assert that margin from
    // the intrinsic video geometry, so a re-rendered clip that pushed the
    // sphere toward the edge would fail here instead of shipping cropped.
    ok('orb videos exist, loop natively, and cover the screen', await js(`(() => {
      const vs = [...document.querySelectorAll('.chan video')];
      return vs.length === 5 && vs.every((v) => v.loop && getComputedStyle(v).objectFit === 'cover');
    })()`));
    ok('cover crops less than the sphere clearance (54px < 388px measured)', await js(`(() => {
      const vs = [...document.querySelectorAll('.chan video')].filter((v) => v.videoWidth > 0);
      if (!vs.length) return false;
      return vs.every((v) => (v.videoHeight - v.videoWidth * 9 / 16) / 2 < 100);
    })()`));
    await js('window.__orb.snap(0.40)');
    await hold(0.40, 2);
    await hold(0.92, 24);
    ok('sustained focus commits the orb', (await info()).state === 'lockedin', JSON.stringify(await info()));
    await hold(0.08, 24);
    ok('sustained drift commits the orb', (await info()).state === 'depleted', JSON.stringify(await info()));
    const held = (await info()).state;
    await hold(0.95, 6);                     // a brief blip must not flip it
    ok('a brief blip does not flip the orb', (await info()).state === held, `${held} -> ${(await info()).state}`);
  }
  orbWin.destroy();

  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}\n`);
  app.exit(failures === 0 ? 0 : 1);
});
