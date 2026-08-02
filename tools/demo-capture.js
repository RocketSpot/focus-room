'use strict';
// ============================================================
// demo-capture.js, film a full session from a REAL recorded one.
// ------------------------------------------------------------
// Replays a saved session record (data/sessions/*.json) through the REAL
// orchestrator and the REAL surfaces, and captures frames off three offscreen
// windows: the TV, the iPad, and the operator console.
//
// Nothing here invents brain data. Every eeg/frame and eeg/brainwaves message
// is read straight out of the recording, and the reveal is computed from those
// same bands by the same reads.js the room uses live. What IS synthetic is only
// the pacing: the reveal steps and the reading are compressed so a 3 minute
// session becomes a watchable demo.
//
// HONEST LIMIT: raw per-channel ADC is deliberately never persisted (it is
// ephemeral by design, see docs/eeg-phase2a1-notes.md), so the signal-check
// scope has no real waveform to replay. That beat is kept short rather than
// filled with a fabricated trace.
//
//   npx electron tools/demo-capture.js [sessionFile]
//
// Writes PNG sequences to data/demo/{tv,ipad,ops} plus edit.json, then
// tools/demo-render.sh turns them into the 2:1 video.
// ============================================================

// pacing knobs must be set BEFORE the orchestrator module reads them
process.env.FOCUSROOM_REVEAL_STEP_MS = process.env.FOCUSROOM_REVEAL_STEP_MS || '5200';
process.env.FOCUSROOM_PROCESS_MS = process.env.FOCUSROOM_PROCESS_MS || '1400';
process.env.FOCUSROOM_BASELINE_MS = process.env.FOCUSROOM_BASELINE_MS || '3500';
process.env.FOCUSROOM_PLATEAU_FALLBACK_MS = '600000';   // we fire the interruption ourselves
process.env.FOCUSROOM_FIT_SETTLE_MS = '1200';
process.env.FOCUSROOM_WINDOWED = '1';
process.env.FOCUSROOM_DND = '0';
process.env.FOCUSROOM_NO_AUDIO = '1';                   // silent capture

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'demo');
const FPS = 10;
const TICK = 1000 / FPS;

// output panel sizes, captured at final size so ffmpeg never rescales the UI
const TV = { w: 1600, h: 900 };
const IPAD = { w: 800, h: 1149 };
const OPS = { w: 1000, h: 1250 };

const sessionFile = process.argv.find((a) => a.endsWith('.json'))
  || path.join(ROOT, 'data', 'sessions', 'session-1785017923930.json');
const REC = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

const { createRoom } = require(path.join(ROOT, 'app', 'room-core.js'));
const config = require(path.join(ROOT, 'app', 'config.js'));

let tvWin = null, ipadWin = null, opsWin = null, tvSurface = null;
const room = createRoom({
  onBeat: ({ surface }) => {
    if (surface === tvSurface) return;
    tvSurface = surface;
    if (tvWin && !tvWin.isDestroyed()) tvWin.loadURL(tvUrl(surface));
  },
});
const { server, orchestrator } = room;

function tvUrl(surface) {
  const f = surface === 'orb' ? 'tv-orb.html'
    : surface === 'signal' ? 'tv-signal.html'
      : surface === 'reveal' ? 'tv-reveal.html'
        : surface === 'live' ? 'tv-live.html' : 'tv-constellation.html';
  return `http://127.0.0.1:${config.net.LAN_PORT}/${f}`;
}

// ---- replay helpers: every EEG value below comes out of the recording ----
const bands = (REC.stream && REC.stream.bands) || [];
const frames = (REC.stream && REC.stream.frames) || [];
const DUR = bands.length ? bands[bands.length - 1].t : 0;

function emit(msg) {
  try { orchestrator.onSidecar(msg); } catch (_) {}
  try { server.broadcast(msg.type, msg); } catch (_) {}
}
const ev = (kind, payload) => orchestrator.onClientMessage(
  { type: 'guest/event', kind, payload: payload || {}, t: Date.now() }, 'ipad');
const intake = (fields) => orchestrator.onClientMessage(
  Object.assign({ type: 'guest/intake', t: Date.now() }, fields), 'ipad');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- frame capture ----
let frameNo = 0;
const edit = [];            // [{frame, view}] so the renderer knows when to cut
let capturing = false;
let view = 'room';          // 'room' (tv+ipad) or 'ops'

async function grab(win, dir) {
  if (!win || win.isDestroyed()) return;
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, dir, String(frameNo).padStart(5, '0') + '.png'), img.toPNG());
  } catch (_) { /* a frame we could not grab is simply skipped */ }
}

async function captureLoop() {
  while (capturing) {
    const t0 = Date.now();
    if (view === 'ops') {
      await grab(opsWin, 'ops');
      // hold the last room frame so the sequences stay the same length
      await Promise.all([grab(tvWin, 'tv'), grab(ipadWin, 'ipad')]);
    } else {
      await Promise.all([grab(tvWin, 'tv'), grab(ipadWin, 'ipad')]);
      await grab(opsWin, 'ops');
    }
    edit.push({ frame: frameNo, view });
    frameNo += 1;
    const spent = Date.now() - t0;
    if (spent < TICK) await sleep(TICK - spent);
  }
}

// cut to the operator console for a beat, then back
async function cutToOps(ms) { view = 'ops'; await sleep(ms); view = 'room'; }

async function main() {
  for (const d of ['tv', 'ipad', 'ops']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
  await room.startServerWithRetry();
  room.wireSurfaces();
  await sleep(600);

  const wp = { backgroundThrottling: false, offscreen: false, contextIsolation: true, nodeIntegration: false };
  // frame:false + useContentSize gives the web area EXACTLY the requested pixels (a
  // title bar was stealing 28px), and enableLargerThanScreen lets the tall iPad and
  // ops windows exceed the physical display instead of being clamped to it.
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
  await sleep(2500);

  capturing = true;
  captureLoop();

  // ============ the session, on the recording's own numbers ============
  await sleep(2500);                                    // idle wall
  orchestrator.onClientHello({ role: 'ipad', clientTime: Date.now() });
  await sleep(2600);                                    // welcome

  ev('earbud_seated');                                  // -> fit, TV shows the signal check
  // replay the opening of the recording so the room has a live line
  let fi = 0;
  const pushFrames = (untilT) => {
    while (fi < frames.length && frames[fi].t <= untilT) {
      const f = frames[fi];
      emit({ type: 'eeg/frame', tRel: f.t, t: Date.now(), engagementRel: f.v, stateWord: f.w || 'settling', signalQuality: 0.95 });
      const b = bands.find((x) => Math.abs(x.t - f.t) < 0.75);
      if (b) emit({ type: 'eeg/brainwaves', delta: b.delta, theta: b.theta, alpha: b.alpha, beta: b.beta, gamma: b.gamma, t: Date.now() });
      fi += 1;
    }
  };
  for (let k = 0; k < 8; k++) { pushFrames(frames[Math.min(fi, frames.length - 1)].t + 0.9); await sleep(300); }

  await cutToOps(3200);                                 // cut 1: the operator's view of the fit
  ev('baseline_start');
  await sleep(3800);                                    // the baseline ring closes
  ev('fit_confirmed');                                  // -> intake
  await sleep(3000);
  intake({ answers: REC.intake || {}, onMind: REC.onMind || '' });   // -> picker
  await sleep(2600);
  intake({ reading: REC.reading || { id: 'demo', title: 'The Signal from Nowhere' } });  // -> reading (orb)

  // ---- the reading itself, compressed but every value is the recording's ----
  const interruptAt = REC.interruptEegT || DUR * 0.4;
  const READ_SECONDS = 34;                              // wall-clock length in the film
  const step = DUR / (READ_SECONDS * (1000 / 260));     // recording seconds per 260ms tick
  let tRel = frames.length ? frames[Math.max(0, fi - 1)].t : 0;
  let fired = false;
  while (tRel < DUR) {
    tRel += step;
    pushFrames(tRel);
    if (!fired && tRel >= interruptAt) { fired = true; orchestrator.forceInterruption(); }
    if (Math.abs(tRel - DUR * 0.55) < step) await cutToOps(2600);   // cut 2: mid-reading
    await sleep(260);
  }

  ev('reading_finished');                               // -> strongest
  await sleep(3200);
  ev('strongest_stretch_guess', { choice: REC.strongestGuess || 'The ending' });   // -> reveal
  await sleep(1800);
  await cutToOps(2400);                                 // cut 3: the console during the reveal
  await sleep(4 * 5200 + 2500);                         // the four reads, at the compressed pace
  ev('reveal_ack');
  await sleep(2600);
  ev('email_entered', { email: 'guest@example.com' });
  await sleep(2600);
  ev('close_choice', { door: REC.closeDoor || 'customer' });
  await sleep(3000);                                    // the dot joins the wall

  capturing = false;
  await sleep(400);
  fs.writeFileSync(path.join(OUT, 'edit.json'), JSON.stringify({
    fps: FPS, frames: frameNo, tv: TV, ipad: IPAD, ops: OPS,
    session: path.basename(sessionFile),
    cuts: edit.filter((e) => e.view === 'ops').map((e) => e.frame),
  }, null, 1));
  console.log(`[demo] captured ${frameNo} frames from ${path.basename(sessionFile)}`);
  app.quit();
}

app.whenReady().then(main).catch((e) => { console.error('[demo] failed:', e); app.quit(); });
app.on('window-all-closed', () => {});
