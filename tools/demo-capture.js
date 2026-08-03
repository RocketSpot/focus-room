'use strict';
// ============================================================
// demo-capture.js, film a full session.
// ------------------------------------------------------------
// WHAT WENT WRONG LAST TIME, and what this fixes.
//
// 1. The operator console read "The signal engine stopped" for the whole film.
//    The capture never called wireSidecar() or supervisor.start(), so
//    supervisor.child was null, info.running was false, and room-core replays
//    that status to any connecting console. It now runs the real engine.
//
// 2. The "This is you" screen was blank. The capture's windows had no preload,
//    so window.__FOCUSROOM__ never existed and subscribeRawEeg was never
//    called; createRoom was also given no onRawEeg hook and configureRawAuth
//    was never called. The raw path was severed at three points. All three are
//    wired here, exactly as app/main.js wires them.
//
// 3. The reading never loaded. Guest events were injected straight into the
//    orchestrator, so the iPad's own React state never learned the guest's
//    choices and screens2 honestly rendered "Your piece loads here". This now
//    drives the REAL iPad by clicking its REAL buttons, so the state is real.
//
// 4. Worst of all, it laundered a refusal. Replaying stored bands with no
//    sidecar left this._eegEligibility null, which defaults revealEligible to
//    true, so a session the room had classed insufficient-usable-data, with the
//    archetype "Not measured this session", came out as "ok" with a full set of
//    measured claims. The recorded quality flags are now carried through, and a
//    session the room refused to interpret still reads as refused.
//
//   npx electron tools/demo-capture.js [sessionFile]
// ============================================================

process.env.FOCUSROOM_SIMULATE = '1';        // the engine runs, and says so on screen
process.env.FOCUSROOM_WINDOWED = '1';
process.env.FOCUSROOM_DND = '0';
process.env.FOCUSROOM_NO_AUDIO = '1';        // the beds are mixed in at render time
process.env.FOCUSROOM_REVEAL_STEP_MS = process.env.FOCUSROOM_REVEAL_STEP_MS || '11000';
process.env.FOCUSROOM_PROCESS_MS = process.env.FOCUSROOM_PROCESS_MS || '2600';
process.env.FOCUSROOM_BASELINE_MS = process.env.FOCUSROOM_BASELINE_MS || '15000';
process.env.FOCUSROOM_PLATEAU_FALLBACK_MS = '600000';   // the interruption is fired on cue
process.env.FOCUSROOM_FIT_SETTLE_MS = '1800';

const { app, BrowserWindow, ipcMain } = require('electron');
process.on('unhandledRejection', (e) => console.error('[demo] unhandled:', e));
process.on('uncaughtException', (e) => console.error('[demo] uncaught:', e));
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'demo');
const FPS = 30;                               // matches the reference film
const TICK = 1000 / FPS;

// 1920x1080 overall: the TV takes two thirds on the left, the iPad the rest.
const TV = { w: 1280, h: 720 };
const IPAD = { w: 640, h: 1080 };
const OPS = { w: 1280, h: 1000 };

const sessionFile = process.argv.find((a) => a.endsWith('.json'))
  || path.join(ROOT, 'data', 'sessions', 'session-1785002748484.json');
const REC = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

const { createRoom } = require(path.join(ROOT, 'app', 'room-core.js'));
const config = require(path.join(ROOT, 'app', 'config.js'));

// the raw-EEG capability token stays in this process, exactly as in main.js
const rawStreamToken = crypto.randomBytes(32).toString('hex');

let tvWin = null, ipadWin = null, opsWin = null, tvSurface = null;
const room = createRoom({
  onBeat: ({ surface }) => {
    if (surface === tvSurface) return;
    tvSurface = surface;
    if (tvWin && !tvWin.isDestroyed()) tvWin.loadURL(tvUrl(surface));
  },
  // the missing half of the raw relay: without this the signal screen has nothing
  onRawEeg: (msg) => {
    if (tvSurface === 'signal' && tvWin && !tvWin.isDestroyed()) {
      try { tvWin.webContents.send('rawEeg:msg', msg); } catch (_) {}
    }
  },
});
const { server, orchestrator, supervisor } = room;

function tvUrl(surface) {
  const f = surface === 'orb' ? 'tv-orb.html'
    : surface === 'signal' ? 'tv-signal.html'
      : surface === 'reveal' ? 'tv-reveal.html'
        : surface === 'live' ? 'tv-live.html' : 'tv-constellation.html';
  return `http://127.0.0.1:${config.net.LAN_PORT}/${f}`;
}
function windowConfigArg() {
  const cfg = { staff: { uiEnabled: false, pin: '' } };
  return '--focusroom-cfg=' + Buffer.from(JSON.stringify(cfg)).toString('base64');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- driving the REAL iPad ------------------------------------------------
// Every guest action is a click on the actual button, so answers.piece,
// answers.email and the rest are set by the same code path a guest uses.
async function tap(re, { nth = 0, timeout = 6000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = await ipadWin.webContents.executeJavaScript(`(() => {
      const rx = ${re};
      const els = [...document.querySelectorAll('button, [role="button"]')]
        .filter((b) => rx.test((b.textContent || '').trim()) && b.offsetParent !== null);
      const el = els[${nth}];
      if (!el) return false;
      el.click();
      return true;
    })()`).catch(() => false);
    if (hit) return true;
    await sleep(250);
  }
  console.log(`[demo] no button matched ${re}`);
  return false;
}
async function typeInto(selector, text) {
  await ipadWin.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    set.set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`).catch(() => false);
}

// ---- frame capture --------------------------------------------------------
let frameNo = 0;
const edit = [];
let capturing = false;
let view = 'room';

async function grab(win, dir) {
  if (!win || win.isDestroyed()) return;
  try {
    const img = await win.webContents.capturePage();
    // JPEG, not PNG. PNG encoding of three frames per tick was the whole
    // bottleneck: it held the loop to about 12 fps, so a film declared at 30
    // would have played two and a half times too fast. At quality 94 the
    // difference is invisible once h264 has been over it.
    const buf = img.toJPEG(94);
    await fs.promises.writeFile(
      path.join(OUT, dir, String(frameNo).padStart(5, '0') + '.jpg'), buf);
  } catch (_) { /* a frame we could not grab is simply skipped */ }
}
async function captureLoop() {
  while (capturing) {
    const t0 = Date.now();
    await Promise.all([grab(tvWin, 'tv'), grab(ipadWin, 'ipad'), grab(opsWin, 'ops')]);
    edit.push({ frame: frameNo, view });
    frameNo += 1;
    const spent = Date.now() - t0;
    if (spent < TICK) await sleep(TICK - spent);
  }
}
async function cutToOps(ms) { view = 'ops'; await sleep(ms); view = 'room'; }

async function main() {
  for (const d of ['tv', 'ipad', 'ops']) {
    fs.rmSync(path.join(OUT, d), { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT, d), { recursive: true });
  }
  await room.startServerWithRetry();
  server.configureRawAuth({ token: rawStreamToken, requireLoopback: true });
  room.wireSurfaces();
  room.wireSidecar();

  // the sender-gated IPC the preload asks for the capability on
  ipcMain.handle('rawEeg:last', (ev) => {
    if (!tvWin || ev.sender !== tvWin.webContents) return null;
    return room.lastEegState ? room.lastEegState() : null;
  });

  const wp = {
    backgroundThrottling: false, contextIsolation: true, nodeIntegration: false,
    preload: path.join(ROOT, 'app', 'preload.js'),
    additionalArguments: [windowConfigArg()],
  };
  const mk = (w, h, bg) => new BrowserWindow({
    width: w, height: h, show: false, frame: false, useContentSize: true,
    enableLargerThanScreen: true, backgroundColor: bg, webPreferences: wp,
  });
  tvWin = mk(TV.w, TV.h, '#060605');
  ipadWin = mk(IPAD.w, IPAD.h, '#060605');
  opsWin = mk(OPS.w, OPS.h, '#141414');

  tvSurface = 'constellation';
  await tvWin.loadURL(tvUrl('constellation'));
  await ipadWin.loadURL(`http://127.0.0.1:${config.net.LAN_PORT}/ipad-flow.html?kiosk=1`);
  await opsWin.loadURL(`http://127.0.0.1:${config.net.LAN_PORT}/ops.html`);

  // the real signal engine, so the console tells the truth and raw actually flows
  await supervisor.start();
  await sleep(3500);

  capturing = true;
  const capT0 = Date.now();
  captureLoop();

  await sleep(2500);                                   // the idle wall

  // The four onboarding slides. Real labels, read out of the JSX rather than
  // guessed: three "Next" then "I have the earbud in".
  for (let i = 0; i < 3; i++) { await tap('/^Next$/i'); await sleep(3400); }
  await tap('/earbud in/i');
  await sleep(2000);

  // the signal check: the five rhythms appear on the TV while the guest settles
  await sleep(7000);
  await cutToOps(3000);                                // cut 1: the operator watching the fit
  await tap("/I.m ready/i");                           // starts the resting baseline
  await sleep(Number(process.env.FOCUSROOM_BASELINE_MS) + 5000);
  await tap('/ready|continue|next|done/i');            // harmless if it auto-advances
  await sleep(2500);

  // Intake, answered the way the recorded guest answered it. Each question is a
  // list of ArrowRow buttons, so the answer text itself is the selector.
  const ans = REC.intake || {};
  for (let qi = 0; qi < 3; qi++) {
    // The recorded answers predate the em-dash sweep, so "A blip - I barely
    // notice" no longer matches the option text verbatim. Match on the leading
    // fragment before any dash or comma, which is distinctive on its own.
    const raw = String(ans[String(qi)] || ans[qi] || '').trim();
    const head = raw.split(/[,\u2014\u2013-]/)[0].trim();
    let hit = false;
    if (head.length >= 3) {
      hit = await tap(new RegExp('^' + head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        { timeout: 4000 });
    }
    // A recording with no answers is a real case: the autopilot ran that session.
    // Take the middle option rather than stalling the film on an unanswered screen.
    if (!hit) await tap('/./', { nth: 1, timeout: 4000 });
    await sleep(1500);
  }

  // the guest's own note, then on to the picker
  if (REC.onMind) { await typeInto('textarea', REC.onMind); await sleep(1200); }
  await tap('/Pick something to read/i');
  await sleep(2600);

  // the piece the recorded guest chose
  const title = (REC.reading && REC.reading.title) || '';
  if (title) await tap(new RegExp(title.slice(0, 22).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  await sleep(3000);

  // ---- the reading ----
  const readSec = 100;
  const fireAt = Math.min(readSec * 0.45, REC.interruptEegT || 30);
  let fired = false;
  for (let t = 0; t < readSec; t += 1) {
    if (!fired && t >= fireAt) { fired = true; orchestrator.forceInterruption(); }
    if (fired && Math.abs(t - (fireAt + 5)) < 0.5) await tap('/Back to reading/i', { timeout: 3000 });
    if (Math.abs(t - readSec * 0.72) < 0.5) await cutToOps(3000);   // cut 2: mid-reading
    await sleep(1000);
  }

  await tap('/finished reading/i');
  await sleep(3200);
  const guess = REC.strongestGuess || 'The ending';
  await tap(new RegExp(guess.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  await sleep(2600);
  await cutToOps(3200);                                 // cut 3: the console during the reveal
  await sleep(Number(process.env.FOCUSROOM_PROCESS_MS) + 4 * Number(process.env.FOCUSROOM_REVEAL_STEP_MS) + 4000);
  await tap('/Reveal finished/i', { timeout: 3000 });
  await sleep(2600);
  await tap('/No thanks|just the card/i');              // no address typed into a film
  await sleep(2600);
  await tap(new RegExp((REC.closeDoor || 'customer'), 'i'), { timeout: 4000 });
  await sleep(2000);
  await tap('/^(?!.*back).{3,40}$/i', { nth: 0, timeout: 3000 });   // the closing call to action
  await sleep(5000);                                    // the dot joins the wall

  capturing = false;
  await sleep(400);
  // The film is rendered at the rate we ACTUALLY achieved, not the rate we asked
  // for, so a session that took four minutes plays back as four minutes.
  const actualFps = frameNo / ((Date.now() - capT0) / 1000);
  fs.writeFileSync(path.join(OUT, 'edit.json'), JSON.stringify({
    fps: Math.round(actualFps * 100) / 100, requestedFps: FPS, frames: frameNo, tv: TV, ipad: IPAD, ops: OPS,
    session: path.basename(sessionFile),
    cuts: edit.filter((e) => e.view === 'ops').map((e) => e.frame),
  }, null, 1));
  console.log(`[demo] captured ${frameNo} frames over ${((Date.now() - capT0) / 1000).toFixed(1)}s `
  + `= ${actualFps.toFixed(2)} fps, from ${path.basename(sessionFile)}`);
  try { await supervisor.stop(); } catch (_) {}
  app.quit();
}

app.whenReady().then(main).catch((e) => { console.error('[demo] failed:', e); app.quit(); });
app.on('window-all-closed', () => {});
