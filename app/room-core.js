'use strict';
// ============================================================
// Zone — The Focus Room :: the room BRAIN, Electron-free.
// ------------------------------------------------------------
// Everything the room does that is not a window lives here: the sidecar
// supervisor, the LAN surface server, the orchestrator, the constellation
// store, the outputs wiring, the ops-console gate, and the crash guard.
// Two entries consume it:
//   app/main.js      — the Electron room (adds the TV window, the hidden
//                      audio host, shortcuts, and the printed card path)
//   app/web-main.js  — the headless web deployment (Replit): the TV is
//                      /tv.html in a browser, the guest is /ipad-flow.html,
//                      the operator is /ops.html
// Extracted from main.js verbatim where possible — behavior identical.
// ============================================================
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { SidecarSupervisor } = require('./sidecar-supervisor');
const { SurfaceServer } = require('./server');
const { Orchestrator } = require('./orchestrator');
const { Store } = require('./store');
const outputs = require('./outputs');
const { SERVER, SIDECAR_OUT, SIDECAR_IN } = require('./protocol');

// Commands the served operator console may fire at the sidecar. An EXPLICIT
// allow-list, NOT all of SIDECAR_IN — the contract also contains 'shutdown',
// which would let any device on the room Wi-Fi kill the signal engine over the
// wire. Killing the engine is never an operator action (it self-manages); the
// console only gets the buttons a human in the room legitimately needs.
const OPS_COMMANDS = new Set([
  SIDECAR_IN.DISCOVER, SIDECAR_IN.CONNECT, SIDECAR_IN.DISCONNECT,
  SIDECAR_IN.START_FIT, SIDECAR_IN.STOP_FIT,
  SIDECAR_IN.START_SESSION, SIDECAR_IN.STOP_SESSION,
  SIDECAR_IN.MARK, SIDECAR_IN.TEST_SIGNAL,
]);

// Sidecar message types that are guest-surface-relevant and broadcast to the
// TV/iPad as-is (the strings already match the LAN contract).
const SURFACE_FORWARD = new Set([
  SIDECAR_OUT.FRAME,
  SIDECAR_OUT.BRAINWAVES,   // guest signal surface renders these as NUMBER-FREE relative presence
  SIDECAR_OUT.CONNECTION,
  SIDECAR_OUT.BATTERY,
  SIDECAR_OUT.IMPEDANCE,
]);

// hooks (all optional):
//   onDiag(channel, payload)  — extra diagnostic sink (Electron's legacy window)
//   onBeat({surface, beat})   — Electron navigates its TV window here
//   onServerUp()              — Electron reloads its windows after a late bind
function createRoom(hooks = {}) {
  const server = new SurfaceServer();
  // The signal engine: local by default (the sidecar spawned on THIS machine —
  // sim or real hardware); FOCUSROOM_SIGNAL=bridge instead accepts the stream
  // from a desktop bridge dialing in over the WS (web room + real earbuds).
  let supervisor;
  if (process.env.FOCUSROOM_SIGNAL === 'bridge') {
    const { RemoteSupervisor } = require('./remote-supervisor');
    supervisor = new RemoteSupervisor(server, process.env.FOCUSROOM_BRIDGE_TOKEN);
  } else {
    supervisor = new SidecarSupervisor();
  }
  const store = new Store();
  let pendingJoin = null; // the dot the next-loaded constellation should animate

  // Mirror the diagnostic feed to the host's sink (if any) and to every
  // connected operator console over the WS bus, under the 'ops' role.
  function pushDiag(channel, payload) {
    try { if (hooks.onDiag) hooks.onDiag(channel, payload); } catch (_) {}
    // Only serialize + fan out when an operator console is actually connected —
    // the feed carries every EEG frame (~1/s), and nobody should pay for it when
    // no one is watching.
    try { if (server && server.hasRole('ops')) server.broadcast('ops/feed', { channel, payload }, 'ops'); } catch (_) {}
  }

  const orchestrator = new Orchestrator({
    supervisor,
    server,
    log: (m) => { if (config.isDev) console.log(`[orch] ${m}`); pushDiag('orch:log', m); },
  });

  // Last-known engine facts, replayed to a LATE-JOINING operator console. The
  // one-shot ready/status/battery messages fire at boot and during the fit —
  // long before an operator usually opens the page — so without a replay the
  // console sat on "Waiting for the signal engine…" with dash chips in the
  // middle of a live session.
  const opsLast = new Map();   // msg.type → last raw sidecar message

  function wireSidecar() {
    // Demo autopilot is OPT-IN (FOCUSROOM_DEMO=1, sim only): by default the room
    // waits for a real guest — open the iPad URL from the console and drive the
    // whole flow by hand (the sim sidecar fakes the earbuds/EEG once you do).
    // An unattended ghost session walking itself feels broken, not alive.
    if (config.SIMULATE && process.env.FOCUSROOM_DEMO === '1') orchestrator.enableDemo();

    supervisor.on('ready', () => {
      pushDiag('sidecar:status', supervisor.info);
      // A restart mid-beat leaves fit/reading silently dead (commands are
      // fire-and-forget) — the orchestrator re-issues what the beat depends on.
      orchestrator.onSidecarReady();
      // The orchestrator owns session lifecycle now — no auto-start. Re-broadcast
      // current state so any already-connected surface syncs.
      orchestrator._broadcastState({ sidecar: supervisor.info });
      orchestrator.startDemo(); // no-op unless demo enabled + idle (sim only)
    });

    supervisor.on('message', (msg) => {
      // Everything goes to the diagnostic view (the honest mirror).
      pushDiag('sidecar:message', msg);
      // The orchestrator maps frames onto the EEG timeline + reacts to plateau/archetype.
      orchestrator.onSidecar(msg);
      // Guest-relevant frames go to the surfaces verbatim.
      if (SURFACE_FORWARD.has(msg.type)) server.broadcast(msg.type, msg);
      // remember the slow-moving facts a late ops console needs on arrival
      if (msg.type === SIDECAR_OUT.BATTERY || msg.type === SIDECAR_OUT.CONNECTION
        || msg.type === SIDECAR_OUT.IMPEDANCE || msg.type === SIDECAR_OUT.READY
        || msg.type === SIDECAR_OUT.HELLO) opsLast.set(msg.type, msg);
      if (msg.type === SIDECAR_OUT.LOG) {
        if (config.isDev) console.log(`[sidecar.log:${msg.level}] ${msg.msg}`);
      }
    });

    supervisor.on('stderr', (line) => pushDiag('sidecar:stderr', line));
    supervisor.on('exit', (info) => { pushDiag('sidecar:status', supervisor.info); });
    supervisor.on('restarting', () => pushDiag('sidecar:status', supervisor.info));
    supervisor.on('connected', () => pushDiag('sidecar:status', supervisor.info));
  }

  function wireSurfaces() {
    // A surface attached (iPad starts a session / TV resyncs).
    server.on('client-hello', (info) => {
      pushDiag('surface:client', { hello: info });
      // a hello from a role that had gone quiet is a RECONNECT, not a new guest —
      // tell the orchestrator so it can stop holding the session open
      orchestrator.onClientRejoined(info.role);
      orchestrator.onClientHello(info);
      // hand a freshly-loaded TV the whole constellation (+ a dot to land if pending)
      if (info.role === 'tv') {
        server.broadcast(SERVER.CONSTELLATION_DATA,
          { dots: store.list(), count: store.count(), joinId: pendingJoin ? pendingJoin.id : null }, 'tv');
        // a TV that just (re)loaded into the reveal missed the one-time reveal/data
        // broadcast — re-send it + the current step so the reveal isn't blank.
        if (orchestrator.beat === 'standby' && orchestrator.reveal) {
          if (!orchestrator.revealShown) {
            // Still inside the post-scan processing pause. Re-sending reveal/data
            // here skipped the processing moment on every real reveal (the TV
            // reloads into standby and hellos DURING the pause) — hand the fresh
            // TV the processing screen instead; reveal/data follows on the timer.
            server.broadcast(SERVER.REVEAL_PROCESSING, { archetype: orchestrator.reveal.archetype }, 'tv');
          } else {
            // one canonical builder — never hand-copy this payload (a drifted copy
            // dropped `bands` and the reveal rendered with empty charts)
            server.broadcast(SERVER.REVEAL_DATA, orchestrator.revealPayload(), 'tv');
            if (orchestrator.revealStep >= 1) server.broadcast(SERVER.REVEAL_STEP, { index: orchestrator.revealStep }, 'tv');
          }
        }
      }
      // a LATE operator console gets the engine's standing facts replayed —
      // otherwise it waits forever for one-shots that fired at boot
      if (info.role === 'ops') {
        pushDiag('sidecar:status', supervisor.info);
        for (const msg of opsLast.values()) {
          server.broadcast(msg.type, msg, 'ops');
          pushDiag('sidecar:message', msg);
        }
      }
    });
    server.on('client-message', ({ role, msg }) => {
      // The desktop signal bridge is plumbing, not a guest: its traffic belongs
      // to the RemoteSupervisor (which listens on the server itself), never to
      // the orchestrator.
      if (role === 'bridge') return;
      // The operator console drives the sidecar directly (Discover/Connect/…). Its
      // commands must NOT flow into the guest orchestrator — validate against the
      // sidecar contract and forward, same gate the old IPC bridge used.
      if (role === 'ops' && msg && msg.type === 'ops/cmd') {
        const cmd = msg.cmd;
        if (cmd === SIDECAR_IN.MARK && (msg.payload || {}).kind === 'interruption') {
          // "Fire the interruption" must do what it says: show the guest the card
          // and mark the real timeline. The raw sidecar `mark` did neither — it
          // only annotated the recording. Route through the orchestrator, which
          // only fires during the reading.
          const fired = orchestrator.forceInterruption();
          pushDiag('orch:log', fired ? 'ops → fired the interruption' : 'ops → interruption ignored (only valid while the guest is reading)');
        } else if (cmd === SIDECAR_IN.TEST_SIGNAL) {
          // The test signal injects a synthetic waveform THROUGH the real pipeline.
          // Fired mid-session it would blend fabricated samples into the guest's
          // actual recording — a silent violation of "nothing fabricated". Only
          // allow it when no guest is in session.
          if (orchestrator.beat === 'idle') {
            const ok = supervisor.send(cmd, msg.payload || {});
            pushDiag('orch:log', `ops → test_signal ${ok ? 'sent' : 'failed (sidecar down)'}`);
          } else {
            pushDiag('orch:log', 'ops → test signal refused (a guest is in session)');
          }
        } else if (OPS_COMMANDS.has(cmd)) {
          const ok = supervisor.send(cmd, msg.payload || {});
          pushDiag('orch:log', `ops → ${cmd} ${ok ? 'sent' : 'failed (sidecar down)'}`);
        } else {
          pushDiag('orch:log', `ops → refused command "${cmd}"`);
        }
        return;
      }
      pushDiag('surface:client', { role, msg });
      orchestrator.onClientMessage(msg, role);
    });
    server.on('client-joined', (info) => pushDiag('surface:client', { joined: info }));
    // A surface dropped off the network. This is the ONLY way the orchestrator
    // learns the guest became unreachable, which is what stops the abandonment
    // watchdog from reading a Wi-Fi blip as someone walking out mid-session.
    server.on('client-left', (info) => {
      pushDiag('surface:client', { left: info });
      orchestrator.onClientLeft(info.role);
    });

    // The host decides what a beat change does to its TV (Electron navigates a
    // window; the web TV shell follows session/state on its own).
    orchestrator.on('beat', ({ surface, beat }) => {
      try { if (hooks.onBeat) hooks.onBeat({ surface, beat }); } catch (_) {}
      pushDiag('orch:beat', { beat, surface });
    });
    orchestrator.on('event', (ev) => pushDiag('orch:event', ev));

    // Outputs: card auto-prints + profile renders the moment results are processed.
    orchestrator.on('process-outputs', async ({ reveal, answers }) => {
      try {
        const out = await outputs.processResults(reveal, answers);
        pushDiag('outputs', { cardPdf: out.cardPdf, cardPrinted: out.cardPrinted, profilePng: out.profilePng, profileReady: out.profileReady });
        server.broadcast(SERVER.OUTPUT_READY, { cardPrinted: out.cardPrinted, profileReady: out.profileReady, emailSent: false });
      } catch (e) { console.error('[outputs] processResults failed:', e.message); }
    });
    // The guest's dot joins the constellation (persisted) and lands on the TV.
    orchestrator.on('dot-join', ({ archetype }) => {
      const dot = store.addDot(archetype);
      pendingJoin = dot;
      server.broadcast(SERVER.CONSTELLATION_JOIN, { dot }); // a TV already on the wall animates it
      setTimeout(() => { if (pendingJoin && pendingJoin.id === dot.id) pendingJoin = null; }, 12000);
      pushDiag('orch:dot-join', dot);
    });

    // The FULL session (focus line, band/metric stream, reads, archetype, answers)
    // is written to disk — the constellation dot is only the anonymous pin.
    orchestrator.on('session-record', (rec) => {
      const p = store.saveSession(rec);
      // always log the path (not just in dev): the operator needs to find a
      // guest's scan data on the room machine without opening a console flag
      if (p) { console.log('[session] saved →', p); pushDiag('session:saved', { id: rec.id, path: p }); }
    });

    // Email sends after the matched close (the captured address + the chosen door).
    orchestrator.on('send-report', async ({ reveal, answers, email }) => {
      try {
        const r = await outputs.sendReport(reveal, answers, email);
        pushDiag('outputs', { emailSent: r.ok, provider: r.provider, id: r.id, path: r.path });
        server.broadcast(SERVER.OUTPUT_READY, { emailSent: !!r.ok });
      } catch (e) { console.error('[outputs] sendReport failed:', e.message); }
    });
  }

  // A busy port must not mean a blank TV all day: keep retrying the bind
  // (every 3s x 5, then every 30s forever) and let the host refresh its
  // windows once bound.
  async function startServerWithRetry() {
    for (let attempt = 1; ; attempt++) {
      try {
        const addr = await server.start();
        console.log(`[server] LAN surface server on :${config.net.LAN_PORT}`);
        (addr.lanUrls || []).forEach((u) => console.log(`         iPad → ${u}`));
        try { if (hooks.onServerUp) hooks.onServerUp(); } catch (_) {}
        return;
      } catch (e) {
        const delayMs = attempt <= 5 ? 3000 : 30000;
        console.error(`[server] failed to start (attempt ${attempt}): ${e.message} — retrying in ${delayMs / 1000}s`);
        pushDiag('server:retry', { attempt, delayMs, error: e.message });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  let cleaningUp = false;
  async function cleanup(extra) {
    if (cleaningUp) return;
    cleaningUp = true;
    try { if (extra) await extra(); } catch (_) {}
    try { await supervisor.stop(); } catch (_) {}
    try { await server.stop(); } catch (_) {}
  }

  // ---------------- crash guard ----------------
  // A crash must not leave the room dark: log it (console + crash log under the
  // data dir), attempt the normal cleanup, then hand the host its relaunch —
  // unless we're crash-looping (more than 3 crashes in 10 minutes), in which
  // case stay down.
  const CRASH_WINDOW_MS = 10 * 60 * 1000;
  const CRASH_MAX_IN_WINDOW = 3;
  const CRASH_LOG = path.join(config.dataDir, 'crash.log');
  const CRASH_HISTORY = path.join(config.dataDir, 'crash-history.json');

  function logCrash(line) {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.appendFileSync(CRASH_LOG, line);
    } catch (_) {}
  }

  // roll the crash-timestamp window forward; returns how many fall inside it
  function recordCrash(now) {
    let stamps = [];
    try { stamps = JSON.parse(fs.readFileSync(CRASH_HISTORY, 'utf8')) || []; } catch (_) {}
    stamps = stamps.filter((t) => typeof t === 'number' && now - t < CRASH_WINDOW_MS);
    stamps.push(now);
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(CRASH_HISTORY, JSON.stringify(stamps));
    } catch (_) {}
    return stamps.length;
  }

  // relaunch(looping: boolean) — host decides how to restart/exit
  function attachCrashGuard(relaunch) {
    let fatalHandled = false;
    function onFatal(kind, err) {
      if (fatalHandled) return; // one fatal at a time — never recurse
      fatalHandled = true;
      const now = Date.now();
      const detail = err && err.stack ? err.stack : String(err);
      console.error(`[crash] ${kind}:`, detail);
      logCrash(`[${new Date(now).toISOString()}] ${kind}: ${detail}\n`);
      const recent = recordCrash(now);
      const finish = () => {
        const looping = recent > CRASH_MAX_IN_WINDOW;
        if (looping) {
          console.error(`[crash] ${recent} crashes in 10 minutes — loop breaker, NOT relaunching`);
          logCrash(`[${new Date().toISOString()}] loop breaker: ${recent} crashes in window — staying down\n`);
        }
        relaunch(looping);
      };
      // attempt the normal cleanup, but never hang the crash path on it
      Promise.race([
        cleanup().catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]).then(finish, finish);
    }
    process.on('uncaughtException', (err) => onFatal('uncaughtException', err));
    process.on('unhandledRejection', (reason) => onFatal('unhandledRejection', reason));
  }

  function banner(label) {
    const line = '─'.repeat(54);
    console.log(`\n${line}`);
    console.log('  ZONE — THE FOCUS ROOM');
    console.log(`  mode      : ${label || (config.isDev ? 'DEV' : 'PACKAGED')}`);
    console.log(`  signal    : ${config.SIMULATE ? '*** SIMULATION (no real guest) ***' : 'REAL EEG'}`);
    console.log(`  sidecar   : ${config.sidecar.frozen ? 'frozen binary' : 'python (dev)'}`);
    console.log(`${line}\n`);
  }

  return {
    config, supervisor, server, store, orchestrator,
    pushDiag, wireSidecar, wireSurfaces, startServerWithRetry,
    cleanup, attachCrashGuard, banner, OPS_COMMANDS, SURFACE_FORWARD,
  };
}

module.exports = { createRoom };
