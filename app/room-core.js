'use strict';
// ============================================================
// Zone, The Focus Room :: the room BRAIN, Electron-free.
// ------------------------------------------------------------
// Everything the room does that is not a window lives here: the sidecar
// supervisor, the LAN surface server, the orchestrator, the constellation
// store, the outputs wiring, the ops-console gate, and the crash guard.
// Two entries consume it:
//   app/main.js     , the Electron room (adds the TV window, the hidden
//                      audio host, shortcuts, and the printed card path)
//   app/web-main.js , the headless web deployment (Replit): the TV is
//                      /tv.html in a browser, the guest is /ipad-flow.html,
//                      the operator is /ops.html
// Extracted from main.js verbatim where possible, behavior identical.
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
// allow-list, NOT all of SIDECAR_IN, the contract also contains 'shutdown',
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
  SIDECAR_OUT.BRAINWAVES,  // guest signal surface renders these as NUMBER-FREE relative presence
  SIDECAR_OUT.CONNECTION,
  SIDECAR_OUT.BATTERY,
  SIDECAR_OUT.IMPEDANCE, SIDECAR_OUT.LEADOFF, SIDECAR_OUT.ANALYSIS,
  // NOTE: EEG_CONFIG / EEG_RAW / EEG_QUALITY are intentionally NOT here, they are
  // routed to the TV role only (item 11), handled explicitly in wireSidecar.
]);

// Diagnostics leave the process (disk trail + operator browser), so keep them
// useful without copying credentials or a guest's full address into every log.
function maskedRecipient(value) {
  const s = String(value || '').trim();
  const at = s.lastIndexOf('@');
  if (at <= 0) return s ? '[invalid address]' : '[no address]';
  const local = s.slice(0, at);
  return `${local.slice(0, 1)}${local.length > 1 ? '***' : ''}${s.slice(at)}`;
}

function safeOpsText(value) {
  if (value == null) return null;
  return String(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted credential]')
    .replace(/\b(POSTMARK(?:_API_KEY|_SERVER_TOKEN)?|X-Postmark-Server-Token|Authorization)\s*[:=]\s*\S+/gi, '$1=[redacted credential]')
    .slice(0, 800);
}

function reportFailureForOps(result, email, sessionId) {
  const r = result || {};
  return {
    severity: 'error',
    actionRequired: true,
    sessionId: sessionId == null ? null : sessionId,
    status: r.status || 'provider-failed',
    recipient: maskedRecipient(email),
    // sendReport/provider own these strings and deliberately keep tokens and
    // upstream response bodies out of them.
    error: safeOpsText(r.error),
    skipped: r.skipped || null,
    diagnosis: safeOpsText(r.diagnosis)
      || 'The report was not sent. Open the saved session and resend it by hand.',
    provider: r.provider || null,
    postmarkCode: r.postmarkCode != null ? r.postmarkCode : null,
    httpStatus: r.httpStatus != null ? r.httpStatus : null,
    recoverAt: r.pendingPath || r.path || null,
    attachmentNames: Array.isArray(r.attachmentNames) ? r.attachmentNames : [],
    attachmentWarnings: Array.isArray(r.attachmentWarnings) ? r.attachmentWarnings : [],
  };
}

// hooks (all optional):
//   onDiag(channel, payload) , extra diagnostic sink (Electron's legacy window)
//   onBeat({surface, beat})  , Electron navigates its TV window here
//   onServerUp()             , Electron reloads its windows after a late bind
function createRoom(hooks = {}) {
  const server = new SurfaceServer();
  // The signal engine: local by default (the sidecar spawned on THIS machine,
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
  // processResults starts at reveal time; sendReport happens minutes later.
  // Retain only the small result promise (paths + flags), keyed by session, so
  // the exact PDF/profile generated for guest A can be attached to guest A's
  // email even if guest B has already entered the room.
  const outputJobs = new Map();

  // Mirror the diagnostic feed to the host's sink (if any) and to every
  // connected operator console over the WS bus, under the 'ops' role.
  // The room's diagnostic feed also lands on DISK now. On the first hardware
  // day every BLE line, reconnect message and analyser counter lived only in
  // the operator console's in-memory pane, so when the runs went wrong there
  // was nothing to read back and the diagnosis took code archaeology against
  // two JSON records. A flat, size-capped log fixes that class of problem
  // permanently. It carries NO raw EEG (raw types never reach pushDiag) and
  // no guest text; it is connection status, engine state and counters.
  const ROOM_LOG = path.join(config.dataDir, 'room.log');
  const ROOM_LOG_MAX = 4 * 1024 * 1024;
  let roomLogSize = null;
  function diskDiag(channel, payload) {
    try {
      if (roomLogSize === null) {
        try { roomLogSize = fs.existsSync(ROOM_LOG) ? fs.statSync(ROOM_LOG).size : 0; }
        catch (_) { roomLogSize = 0; }
      }
      let body = JSON.stringify(payload);
      if (body && body.length > 16384) body = JSON.stringify({ truncated: true, head: body.slice(0, 16000) });
      const line = new Date().toISOString() + ' ' + channel + ' ' + body + '\n';
      if (roomLogSize > ROOM_LOG_MAX) {
        // one rotation deep: yesterday's truth is worth keeping, last week's is not
        try { fs.renameSync(ROOM_LOG, ROOM_LOG + '.1'); } catch (_) {}
        roomLogSize = 0;
      }
      roomLogSize += Buffer.byteLength(line);
      fs.appendFile(ROOM_LOG, line, () => {});
    } catch (_) { /* the log must never be able to hurt the room */ }
  }
  // the trail is diagnostics, not the session record: a guest's email address
  // is recognisable there (a***@domain) but never raw
  function maskEmailIn(obj) {
    const raw = obj && obj.payload && typeof obj.payload.email === 'string'
      ? obj.payload.email : null;
    if (!raw) return obj;
    const at = raw.indexOf('@');
    const masked = at > 1 ? raw[0] + '***' + raw.slice(at) : '***';
    return Object.assign({}, obj, { payload: Object.assign({}, obj.payload, { email: masked }) });
  }
  function pushDiag(channel, payload) {
    try { if (hooks.onDiag) hooks.onDiag(channel, payload); } catch (_) {}
    // the frame channel is ~1/s of noise with no diagnostic value on disk
    if (channel !== 'eeg:frame') diskDiag(channel, payload);
    // Only serialize + fan out when an operator console is actually connected,
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
  // one-shot ready/status/battery messages fire at boot and during the fit,
  // long before an operator usually opens the page, so without a replay the
  // console sat on "Waiting for the signal engine…" with dash chips in the
  // middle of a live session.
  const opsLast = new Map();   // msg.type → last raw sidecar message
  // Phase 2A: a TV loading tv-signal after the fit stream started would miss the
  // one-shot config (channel labels) and the latest quality, cache + replay them.
  let lastEegConfig = null;
  let lastEegQuality = null;

  function wireSidecar() {
    // Demo autopilot is OPT-IN (FOCUSROOM_DEMO=1, sim only): by default the room
    // waits for a real guest, open the iPad URL from the console and drive the
    // whole flow by hand (the sim sidecar fakes the earbuds/EEG once you do).
    // An unattended ghost session walking itself feels broken, not alive.
    if (config.SIMULATE && process.env.FOCUSROOM_DEMO === '1') orchestrator.enableDemo();

    supervisor.on('ready', () => {
      pushDiag('sidecar:status', supervisor.info);
      // A restart mid-beat leaves fit/reading silently dead (commands are
      // fire-and-forget), the orchestrator re-issues what the beat depends on.
      orchestrator.onSidecarReady();
      // The orchestrator owns session lifecycle now, no auto-start. Re-broadcast
      // current state so any already-connected surface syncs.
      orchestrator._broadcastState({ sidecar: supervisor.info });
      orchestrator.startDemo(); // no-op unless demo enabled + idle (sim only)
    });

    supervisor.on('message', (msg) => {
      const isRaw = msg.type === SIDECAR_OUT.EEG_RAW
        || msg.type === SIDECAR_OUT.EEG_CONFIG || msg.type === SIDECAR_OUT.EEG_QUALITY;
      // Everything goes to the diagnostic view (the honest mirror), EXCEPT the raw-EEG
      // message types (finding #5): the ops/feed fanout goes to the self-declared 'ops'
      // role, which is NOT raw-authorized, so raw ADC/channel/quality data must never ride it.
      if (!isRaw) pushDiag('sidecar:message', msg);
      // The orchestrator maps frames onto the EEG timeline + reacts to plateau/archetype.
      orchestrator.onSidecar(msg);
      // Phase 2A.1 raw-EEG routing (item 11) + finding #5: the raw per-channel stream (and its
      // config/quality) is delivered ONLY to sockets the server AUTHENTICATED for the eeg-raw
      // capability (launcher token + loopback in packaged mode), never by the client-declared
      // 'tv' role. It is NOT sent to the iPad, reveal, audio, ops, email, or analytics.
      if (isRaw) {
        // Electron: deliver to the AUTHORIZED TV renderer over IPC (finding #5, the token stays
        // in main; the renderer never holds it). WS: broadcastRaw stays as fail-closed defense for
        // any future launcher-authenticated WebSocket client (a plain/LAN socket is never authorized).
        if (hooks.onRawEeg) { try { hooks.onRawEeg(msg); } catch (_) {} }
        server.broadcastRaw(msg.type, msg);
        if (msg.type === SIDECAR_OUT.EEG_CONFIG) lastEegConfig = msg;
        else if (msg.type === SIDECAR_OUT.EEG_QUALITY) lastEegQuality = msg;
      } else if (SURFACE_FORWARD.has(msg.type)) {
        server.broadcast(msg.type, msg);
      }
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
    // Spawn/TCP faults (missing interpreter, port trouble). The supervisor's
    // backoff ladder handles recovery; this only makes the fault visible.
    supervisor.on('fault', (err) => {
      console.error('[supervisor] fault:', err && err.message ? err.message : err);
      pushDiag('sidecar:status', supervisor.info);
    });
  }

  function wireSurfaces() {
    // A surface attached (iPad starts a session / TV resyncs).
    server.on('client-hello', (info) => {
      pushDiag('client:join', info);
      pushDiag('surface:client', { hello: info });
      // a hello from a role that had gone quiet is a RECONNECT, not a new guest,
      // tell the orchestrator so it can stop holding the session open
      orchestrator.onClientRejoined(info.role);
      orchestrator.onClientHello(info);
      // Re-sends and replays target the client that just arrived (sendTo, not a
      // role broadcast): re-broadcasting to the whole role re-ran the reveal's
      // draw-in on the live TV and re-fired stale chips on every open console
      // whenever one more client connected. Fall back to the role broadcast
      // only if the targeted send fails (client raced away).
      const sendOr = (type, payload, role) => {
        if (!server.sendTo || !server.sendTo(info.id, type, payload)) server.broadcast(type, payload, role);
      };
      // hand a freshly-loaded TV the whole constellation (+ a dot to land if pending)
      if (info.role === 'tv') {
        // a TV that just loaded the signal-check surface mid-stream missed the one-shot EEG
        // config (channel labels) and latest quality, replay them, but ONLY to a socket the
        // server AUTHENTICATED for raw (finding #5): a spoofed 'tv' hello with no launcher token
        // is not raw-authorized (info.rawEeg false) and must not receive even the config/quality.
        if (info.rawEeg && server.sendRawTo) {
          if (lastEegConfig) server.sendRawTo(info.id, lastEegConfig.type, lastEegConfig);
          if (lastEegQuality) server.sendRawTo(info.id, lastEegQuality.type, lastEegQuality);
        }
        sendOr(SERVER.CONSTELLATION_DATA,
          { dots: store.list(), count: store.count(), joinId: pendingJoin ? pendingJoin.id : null }, 'tv');
        // a TV that just (re)loaded into the reveal missed the one-time reveal/data
        // broadcast, re-send it + the current step so the reveal isn't blank.
        if (orchestrator.beat === 'standby' && orchestrator.reveal) {
          if (!orchestrator.revealShown) {
            // Still inside the post-scan processing pause. Re-sending reveal/data
            // here skipped the processing moment on every real reveal (the TV
            // reloads into standby and hellos DURING the pause), hand the fresh
            // TV the processing screen instead; reveal/data follows on the timer.
            sendOr(SERVER.REVEAL_PROCESSING, { archetype: orchestrator.reveal.archetype }, 'tv');
          } else {
            // one canonical builder, never hand-copy this payload (a drifted copy
            // dropped `bands` and the reveal rendered with empty charts)
            sendOr(SERVER.REVEAL_DATA, orchestrator.revealPayload(), 'tv');
            if (orchestrator.revealStep >= 1) sendOr(SERVER.REVEAL_STEP, { index: orchestrator.revealStep }, 'tv');
          }
        }
      }
      // An iPad that reloaded late in the session (Safari purges background
      // pages) lost its reveal state, and the Close screen would have fallen
      // back to the synthetic archetype curve, hand it the guest's REAL data.
      if (info.role === 'ipad' && orchestrator.reveal && orchestrator.revealShown
        && (orchestrator.beat === 'standby' || orchestrator.beat === 'email' || orchestrator.beat === 'close')) {
        sendOr(SERVER.REVEAL_DATA, orchestrator.revealPayload(), 'ipad');
      }
      // a LATE operator console gets the engine's standing facts replayed,
      // otherwise it waits forever for one-shots that fired at boot
      if (info.role === 'ops') {
        pushDiag('sidecar:status', supervisor.info);
        for (const msg of opsLast.values()) {
          if (!server.sendTo || !server.sendTo(info.id, msg.type, msg)) server.broadcast(msg.type, msg, 'ops');
        }
      }
    });
    server.on('client-message', ({ role, msg }) => {
      // EVERY inbound action - every iPad tap, every operator command - lands
      // in the trail with its role and timestamp before it is acted on.
      // The one exception is the guest's email address: the trail and its ops
      // mirror are diagnostics, not the session record, and the address was
      // being written into both raw against the masking policy the outputs
      // pipeline already follows. The record keeps the real address; the
      // trail keeps enough to recognise it.
      pushDiag('client:msg', { role, msg: maskEmailIn(msg) });
      // The desktop signal bridge is plumbing, not a guest: its traffic belongs
      // to the RemoteSupervisor (which listens on the server itself), never to
      // the orchestrator.
      if (role === 'bridge') return;
      // The operator console drives the sidecar directly (Discover/Connect/…). Its
      // commands must NOT flow into the guest orchestrator, validate against the
      // sidecar contract and forward, same gate the old IPC bridge used.
      if (role === 'ops' && msg && msg.type === 'ops/cmd') {
        const cmd = msg.cmd;
        if (cmd === SIDECAR_IN.MARK && (msg.payload || {}).kind === 'interruption') {
          // "Fire the interruption" must do what it says: show the guest the card
          // and mark the real timeline. The raw sidecar `mark` did neither, it
          // only annotated the recording. Route through the orchestrator, which
          // only fires during the reading.
          const fired = orchestrator.forceInterruption();
          pushDiag('orch:log', fired ? 'ops → fired the interruption' : 'ops → interruption ignored (only valid while the guest is reading)');
        } else if (cmd === 'staff_override') {
          // Phase 2A.2 correction 1: explicit, staff-only demonstration override. Lets
          // the room be walked through without valid EEG; the session is marked invalid
          // for EEG interpretation (no EEG-derived guest claims) and shows a visible
          // staff-mode indicator on every surface. Toggled from the operator console.
          const on = !!(msg.payload && msg.payload.on);
          const state = orchestrator.setStaffOverride(on, (msg.payload || {}).reason || 'ops console');
          pushDiag('orch:log', `ops → staff override ${state ? 'ENABLED (session invalid-for-eeg-interpretation)' : 'cleared'}`);
        } else if (cmd === SIDECAR_IN.TEST_SIGNAL) {
          // The test signal injects a synthetic waveform THROUGH the real pipeline.
          // Fired mid-session it would blend fabricated samples into the guest's
          // actual recording, a silent violation of "nothing fabricated". Only
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
      // Phase 2A.2 correction 2: the room-audio host reports its interruption DUCK
      // marker (scheduled Web-Audio clock time). It is NOT a guest and must never drive
      // the FSM, route only this one event to the timing instrumentation, then stop.
      if (role === 'audio') {
        if (msg && msg.type === 'audio/event' && msg.kind === 'ducked') orchestrator.onRoomAudioEvent(msg);
        return;
      }
      pushDiag('surface:client', { role, msg: maskEmailIn(msg) });
      orchestrator.onClientMessage(msg, role);
    });
    server.on('client-joined', (info) => pushDiag('surface:client', { joined: info }));
    // A surface dropped off the network. This is the ONLY way the orchestrator
    // learns the guest became unreachable, which is what stops the abandonment
    // watchdog from reading a Wi-Fi blip as someone walking out mid-session.
    // ---- total outbound tee ----------------------------------------------
    // Everything the room SENDS is everything a surface SHOWS. Every broadcast
    // and targeted send lands in the trail, so a screenshot of any screen can
    // be lined up against the exact payload that drew it. ops/feed is skipped
    // (it carries the trail itself: logging it loops), sidecar-originated
    // eeg/* and fit/* types are skipped (already teed once as sidecar:message),
    // and raw EEG never reaches pushDiag by design.
    const _shouldTeeOut = (type) => type !== 'ops/feed'
      && !String(type).startsWith('eeg/') && !String(type).startsWith('fit/');
    const _bc = server.broadcast.bind(server);
    server.broadcast = (type, payload, role) => {
      if (_shouldTeeOut(type)) pushDiag('room:out', { type, to: role || 'all', payload });
      return _bc(type, payload, role);
    };
    if (server.sendTo) {
      const _st = server.sendTo.bind(server);
      server.sendTo = (id, type, payload) => {
        if (_shouldTeeOut(type)) pushDiag('room:out', { type, to: id, payload });
        return _st(id, type, payload);
      };
    }
    // renderer JS errors from any surface (sendBeacon endpoint in server.js)
    server.on('client-error', (report) => pushDiag('client:error', report));
    // what each screen actually drew, including measured unfilled area, text
    // overlaps and elements past the viewport (see surface-report.js)
    server.on('surface-report', (r) => pushDiag('surface:screen', r));

    server.on('client-left', (info) => {
      pushDiag('client:leave', info);
      pushDiag('surface:client', { left: info });
      orchestrator.onClientLeft(info.role);
    });

    // The host decides what a beat change does to its TV (Electron navigates a
    // window; the web TV shell follows session/state on its own).
    orchestrator.on('beat', ({ surface, beat }) => {
      try { if (hooks.onBeat) hooks.onBeat({ surface, beat }); } catch (_) {}
      pushDiag('orch:beat', { beat, surface });
    });
    orchestrator.on('event', (ev) => pushDiag('orch:event', maskEmailIn(ev)));

    // Outputs: card auto-prints + profile renders the moment results are processed.
    orchestrator.on('process-outputs', async ({ reveal, answers, sessionId }) => {
      const key = sessionId == null ? null : String(sessionId);
      const job = outputs.processResults(reveal, answers);
      if (key != null) {
        // Cache only paths, not `out.data` (which contains the whole focus line).
        outputJobs.set(key, job.then((out) => ({
          cardPdf: out.cardPdf || null,
          profilePng: out.profilePng || null,
          cardPdfExpected: !out.cardSkipped,
          profilePngExpected: !out.profileSkipped,
        }), () => null));
        // Sessions where the guest skips email otherwise have no consumer.
        // Bound the cache while retaining far more than one room could have in
        // flight during the render/send window.
        while (outputJobs.size > 20) outputJobs.delete(outputJobs.keys().next().value);
      }
      try {
        const out = await job;
        pushDiag('outputs', {
          sessionId: sessionId == null ? null : sessionId,
          cardPdf: out.cardPdf, cardPrinted: out.cardPrinted, cardSkipped: out.cardSkipped || null,
          profilePng: out.profilePng, profileReady: out.profileReady, profileSkipped: out.profileSkipped || null,
        });
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
    // is written to disk, the constellation dot is only the anonymous pin.
    orchestrator.on('session-record', (rec) => {
      const p = store.saveSession(rec);
      // always log the path (not just in dev): the operator needs to find a
      // guest's scan data on the room machine without opening a console flag
      if (p) { console.log('[session] saved →', p); pushDiag('session:saved', { id: rec.id, path: p }); }
    });

    // Email sends after the matched close (the captured address + the chosen door).
    // A failure here is the loudest thing the room can say short of stopping: the
    // guest was told their report would land before they left the building, and
    // the only person who can still keep that promise is the operator. So the
    // outcome goes to the trail on disk, to the ops console, and onto the guest's
    // own session record. This used to be a bare console.error, which meant a
    // dead Postmark token produced a completely silent room.
    orchestrator.on('send-report', async ({ reveal, answers, email, sessionId }) => {
      let r;
      const key = sessionId == null ? null : String(sessionId);
      try {
        let artifacts = null;
        const outputJob = key == null ? null : outputJobs.get(key);
        if (outputJob) {
          try {
            artifacts = await outputJob;
          } catch (_) { /* the HTML report still sends; process failure is already logged */ }
        }
        r = await outputs.sendReport(reveal, answers, email, { artifacts });
      } catch (e) {
        // sendReport is written not to throw; if it ever does, that is itself a
        // failure the operator must see rather than a line in a hidden console.
        r = { ok: false, composed: false, sent: false, accepted: false, delivered: false,
          status: 'pipeline-failed', error: 'report pipeline error',
          diagnosis: 'the report pipeline stopped before it could hand the message to Postmark. Use the saved session record to resend it.' };
      } finally {
        if (key != null) outputJobs.delete(key);
      }
      // `sent` is provider acceptance; a dev-file write is composed but unsent.
      const sent = !!r.sent;
      pushDiag('outputs', {
        sessionId: sessionId == null ? null : sessionId,
        emailSent: sent, emailStatus: r.status || null,
        accepted: !!r.accepted, delivered: r.delivered == null ? null : !!r.delivered,
        provider: r.provider || null, id: r.id || null, path: r.path || null,
        attachmentNames: Array.isArray(r.attachmentNames) ? r.attachmentNames : [],
        attachmentWarnings: Array.isArray(r.attachmentWarnings) ? r.attachmentWarnings : [],
      });
      if (!sent) {
        const failure = reportFailureForOps(r, email, sessionId);
        console.error(`[outputs] REPORT NOT SENT (${failure.status}) for ${failure.recipient}: ${failure.diagnosis}`);
        pushDiag('outputs:report-failed', failure);
      }
      // the guest's own record carries the exact acceptance/local/failure state
      try { orchestrator.noteReportDelivery(r, sessionId); } catch (e) { pushDiag('outputs:report-failed', { recordError: e.message }); }
      server.broadcast(SERVER.OUTPUT_READY, {
        emailSent: sent,
        emailStatus: r.status || (sent ? 'provider-accepted' : 'provider-failed'),
      });
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
        console.error(`[server] failed to start (attempt ${attempt}): ${e.message}, retrying in ${delayMs / 1000}s`);
        pushDiag('server:retry', { attempt, delayMs, error: e.message });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  let cleaningUp = false;
  async function cleanup(extra) {
    if (cleaningUp) return;
    cleaningUp = true;
    // Shutdown must never be able to hang the app: every step is best-effort
    // and the whole sequence has a hard deadline. Anything a stuck step would
    // have released gets released anyway when the process exits.
    const work = (async () => {
      try { if (extra) await extra(); } catch (_) {}
      try { await supervisor.stop(); } catch (_) {}
      try { await server.stop(); } catch (_) {}
    })();
    await Promise.race([work, new Promise((r) => setTimeout(r, 5000))]);
  }

  // ---------------- crash guard ----------------
  // A crash must not leave the room dark: log it (console + crash log under the
  // data dir), attempt the normal cleanup, then hand the host its relaunch,
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

  // relaunch(looping: boolean), host decides how to restart/exit
  function attachCrashGuard(relaunch) {
    let fatalHandled = false;
    function onFatal(kind, err) {
      if (fatalHandled) return; // one fatal at a time, never recurse
      fatalHandled = true;
      const now = Date.now();
      const detail = err && err.stack ? err.stack : String(err);
      console.error(`[crash] ${kind}:`, detail);
      logCrash(`[${new Date(now).toISOString()}] ${kind}: ${detail}\n`);
      const recent = recordCrash(now);
      const finish = () => {
        const looping = recent > CRASH_MAX_IN_WINDOW;
        if (looping) {
          console.error(`[crash] ${recent} crashes in 10 minutes, loop breaker, NOT relaunching`);
          logCrash(`[${new Date().toISOString()}] loop breaker: ${recent} crashes in window, staying down\n`);
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
    console.log('  ZONE, THE FOCUS ROOM');
    console.log(`  mode      : ${label || (config.isDev ? 'DEV' : 'PACKAGED')}`);
    console.log(`  signal    : ${config.SIMULATE ? '*** SIMULATION (no real guest) ***' : 'REAL EEG'}`);
    console.log(`  sidecar   : ${config.sidecar.frozen ? 'frozen binary' : 'python (dev)'}`);
    console.log(`${line}\n`);
  }

  return {
    config, supervisor, server, store, orchestrator,
    pushDiag, wireSidecar, wireSurfaces, startServerWithRetry,
    cleanup, attachCrashGuard, banner, OPS_COMMANDS, SURFACE_FORWARD,
    // last-known raw config/quality, replayed to a freshly-loaded signal surface over IPC (finding #5)
    lastEegState: () => ({ config: lastEegConfig, quality: lastEegQuality }),
  };
}

module.exports = { createRoom, maskedRecipient, reportFailureForOps };
