'use strict';
// ============================================================
// orchestrator.js, the session brain (no operator).
// ------------------------------------------------------------
// Owns the beat state machine, drives the sidecar (fit → stream), fires the one
// interruption on the real plateau, paces the reveal, and keeps the iPad and TV
// on the same page automatically. The Mac Mini owns the master clock; the iPad
// syncs to it and stamps every guest event, which we map onto the EEG timeline.
// Phase 3 builds the flow + sync; Phase 4 adds the real four-read content,
// archetype framing, and the edge cases.
// ============================================================
const { EventEmitter } = require('events');
const { performance: perf } = require('perf_hooks');   // monotonic clock (core node; no electron)
const { SERVER, CLIENT, GUEST_EVENT, SIDECAR_IN, SIDECAR_OUT } = require('./protocol');
const { computeReads } = require('./reads');

// Beat order matches the iPad screen set (idle is "no guest").
const BEATS = ['idle', 'welcome', 'fit', 'intake', 'picker', 'reading', 'strongest', 'standby', 'email', 'close'];

// Which TV surface each beat shows.
const TV_SURFACE = {
  idle: 'constellation', welcome: 'constellation', fit: 'signal',
  intake: 'constellation', picker: 'constellation',
  reading: 'orb', strongest: 'orb',
  standby: 'reveal',
  email: 'constellation', close: 'constellation',
};

const REVEAL_STEPS = 4;
// ~1 minute per read (Document.pdf ~4-min reveal). Override for demos/tests.
const REVEAL_STEP_MS = parseInt(process.env.FOCUSROOM_REVEAL_STEP_MS || '60000', 10);
// If no clean plateau appears after a few minutes of reading, fire at the best
// high point so the session never stalls (Document.pdf). Override for tests.
// The resting baseline: fifteen still seconds, EYES OPEN. Eyes-open is the right
// reference here because the reading itself is done eyes-open, alpha rises
// sharply the moment the eyes close (Berger's alpha block), so an eyes-closed
// baseline would confound eye state with attention and make every later
// comparison read as a bigger change than it was.
const BASELINE_MS = parseInt(process.env.FOCUSROOM_BASELINE_MS || '15000', 10);

// 3.5 minutes outlived the reading itself, guests finished the passage before
// the fallback ever fired. 75s lands inside every piece while still giving the
// real EEG plateau the first chance to trigger it.
const PLATEAU_FALLBACK_MS = parseInt(process.env.FOCUSROOM_PLATEAU_FALLBACK_MS || '75000', 10);
// The plateau path assumes minutes of reading. On a SHORT piece the plateau
// often never forms and the 75s fallback can land near, or after, the end,
// which is exactly what happened on the first real run: one notification,
// far too late for the reading it interrupted. So the guest's own progress
// through the page is a third trigger: past this fraction of the piece,
// the notification fires (stream permitting), because the whole point is to
// interrupt a person who is DEEP IN THE MIDDLE of reading, and the middle
// is defined by the page, not by a wall clock. Tunable, like the rest, for
// the thresholds Ryan will supply later.
const INTERRUPT_AT_PROGRESS = parseFloat(process.env.FOCUSROOM_INTERRUPT_AT_PROGRESS || '0.4');
// never fire in the opening moments regardless of how fast someone scrolls:
// the settle-in stretch is a measurement too, and it needs room to exist
const INTERRUPT_MIN_READING_MS = parseInt(process.env.FOCUSROOM_INTERRUPT_MIN_READING_MS || '20000', 10);

// The reveal's post-scan processing pause: the room reads the session before it
// shows the reveal. Real work is instant; this frames it. Tests set it to 0.
const PROCESS_MS = parseInt(process.env.FOCUSROOM_PROCESS_MS || '3000', 10);

// ============================================================
// LINK RESILIENCE, a dropped link is a PAUSE, never a decision.
// ------------------------------------------------------------
// Bluetooth and Wi-Fi both drop in a real room, and when they do there is a
// guest sitting in that room with buds in their ears, mid-session. So nothing
// in this file may respond to a drop by cancelling the session, restarting a
// beat, resetting the flow, or showing anyone an error. Every drop resolves
// exactly one of two ways: the link returns and the session continues from
// where it stood, or the room waits calmly for it.
//
// Three links can fail independently:
//   • the BUDS ↔ sidecar (Bluetooth). The SDK reconnects itself; our job is to
//     notice the stream went quiet, hold everything, and say so gently.
//   • the iPad/TV ↔ app (Wi-Fi). The clients reconnect with backoff; our job is
//     to not mistake an unreachable guest for an absent one.
//   • the sidecar process itself. The supervisor already restarts it; our job
//     is to keep the session's clock continuous across the gap.
// ============================================================

// No frames for this long and the EEG stream is treated as stalled. Frames
// arrive ~1/s, so this is several missed frames, long enough not to trip on
// ordinary scheduling jitter, short enough that the guest isn't left staring at
// a frozen line wondering whether the room broke.
const EEG_STALL_MS = parseInt(process.env.FOCUSROOM_EEG_STALL_MS || '6000', 10);
// Check often enough that the poll interval isn't itself most of the detection
// latency: at the 6s default this is 1s (so a dropout surfaces within ~7s), and
// it scales down with the threshold instead of staying pinned at a fixed tick.
const EEG_STALL_TICK_MS = Math.max(100, Math.min(1000, Math.floor(EEG_STALL_MS / 3)));

// Abandonment watchdog: the only guest path back to idle is close_choice, so a
// guest who walks away mid-flow would wedge the room for every following guest.
// Per-beat inactivity budgets; any client message or hello refreshes the clock.
// (FOCUSROOM_IDLE_RESET_MS overrides every budget, read at arm time so tests
// can flip it on a live orchestrator.)
const MIN_MS = 60 * 1000;
const WATCHDOG_BUDGET_MS = {
  welcome: 6 * MIN_MS, fit: 6 * MIN_MS, intake: 6 * MIN_MS, picker: 6 * MIN_MS,
  strongest: 6 * MIN_MS, email: 6 * MIN_MS, close: 6 * MIN_MS,
  standby: 8 * MIN_MS,  // the reveal auto-advances long before this
  reading: 30 * MIN_MS, // a guest reads silently, long budget
  // idle: no budget, there is nothing to abandon
};

// The watchdog above measures GUEST inactivity, which it can only honestly do
// while the guest is reachable. While the iPad is off the network the budget is
// held (see _abandonSession). This ceiling is the one exception: if nothing
// comes back for this long the room reclaims itself, so a router that dies
// overnight can't leave the next morning's first guest facing a wedged session.
// Deliberately far beyond any plausible outage.
const LINK_LOST_CEILING_MS = parseInt(process.env.FOCUSROOM_LINK_LOST_MS || String(45 * MIN_MS), 10);

// THE ROOM NEVER WAITS ON SIGNAL QUALITY. The signal check is a moment to look at
// your own brain, not a gate to pass: after this short settle the room is simply
// ready, whatever the signal is doing. (It used to require N clean frames AND
// analysis eligibility, so a marginal fit could lock the room and leave a guest
// staring at "Adjusting the fit" forever.) Quality is still measured, it just goes
// to the operator now, never to the guest, and never blocks anyone.
const FIT_SETTLE_MS = parseInt(process.env.FOCUSROOM_FIT_SETTLE_MS
  || process.env.FOCUSROOM_FIT_HINT_MS || '1800', 10);

class Orchestrator extends EventEmitter {
  constructor({ supervisor, server, log }) {
    super();
    this.sup = supervisor;
    this.server = server;
    this.log = log || (() => {});
    // sim demo autopilot state (persists across sessions; never touched by _clearSession)
    this._demoEnabled = false; this._demoActive = false; this._demoSending = false; this._demoTimers = [];
    // staff/demonstration override (correction 1): an explicit, visible, staff-only
    // switch that lets the room be walked through WITHOUT valid EEG. It persists across
    // sessions until a staff member clears it (like the demo state), the safe direction,
    // since it only SUPPRESSES claims, never fabricates them. Set via setStaffOverride().
    this._staffOverride = false;
    this.reset();
  }

  reset() {
    this.beat = 'idle';
    this._clearSession();
    this._clearWatchdog(); // idle has no inactivity budget
  }

  // Wipe everything a session accumulated (answers, reveal, revealStep, timers,
  // signal flags) WITHOUT touching the beat, reset() and the abandonment
  // watchdog both use it.
  _clearSession() {
    this._clearReveal();
    this._stopStallWatch();
    this._clearReadingFallback();
    this._clearFitHint();
    this.answers = { intake: {}, onMind: '', reading: null, archetype: 'deep', archetypeName: 'Deep Diver' };
    this.timeline = { streamEpoch: null, lastFrame: null }; // EEG timeline anchor (master ms)
    this.events = [];            // [{kind, masterT, eegT}]
    this.interruptionFired = false;
    this.interruptEegT = null;
    this.interruptionTiming = null;   // Phase 2A event-timing record
    this.signalIssue = false;
    this._lowSqCount = 0;
    this._reseatActive = false;
    this._fitAllGood = false;
    this._fitGood = 0;           // consecutive clean-signal frames during the signal check
    this._fitSlow = false;
    // Phase 2A: EEG-quality gate state (from eeg/quality-v1)
    this._eegQualitySeen = false;
    this._eegQualityStatus = null;
    this._fitQualityOk = false;
    // Phase 2A.2 correction 1: the eligibility state machine (from eeg/quality-v1).
    // transportReady (packets arriving) is NOT enough to advance, analysisEligible
    // (a grossly-usable channel on EACH ear) is what unlocks the ready state.
    this._eegEligibility = null;     // last eligibility object from the sidecar
    this._eegSimulation = null;      // whether the quality stream is simulated
    this._eegEligKey = null;         // change-detection so we only rebroadcast on a real change
    this._coachKey = null;           // last operator coaching prompt (de-dup)
    this.sessionDataQualityStatus = null;   // 'ok' | 'insufficient-usable-data' | 'invalid-for-eeg-interpretation'
    this.sessionSamples = null;
    this.reveal = null;
    this.revealTimer = null;
    this.revealStep = 0;
    this.revealShown = false;
    // full-session recording, persisted to disk (not just the constellation dot)
    this.sessionId = null;
    this.sessionStartedAt = null;
    this.streamLog = null;       // { frames, bands, metrics } captured live during the reading
    this.impedanceLog = [];      // per-channel contact-density snapshots from the signal check
    this.baseline = null;        // the 15s eyes-open resting reference (opened by baseline_start)
    this.scrollTrack = [];       // [{t, p}] how far through the piece the guest had read, on the EEG clock
    // ---- link resilience (session-scoped) ----
    this._lastFrameAt = null;    // master ms of the last EEG frame, the stall detector's input
    this._eegDown = false;       // the stream went quiet and we're waiting for it
    // A stale link-lost stamp must not survive into the next session: it made
    // the next guest's first hello record a spurious multi-hour link_restored
    // event into the fresh session's log.
    this._linkLostAt = null;
    this._budsConnected = null;  // last eeg/connection verdict (null = not reported yet)
    this._streamGaps = [];       // [{from, to}] stream-clock seconds with no signal
    this._gapOpenT = null;       // stream time a still-open gap started at
    // The stream clock must never run backwards. A sidecar restart re-anchors
    // tRel at 0, so every later sample would land back at the start of the
    // chart and scramble the session's timeline. The offset carries the clock
    // across the gap instead.
    this._streamOffset = 0;
    this._maxStreamT = 0;
  }

  // ---------------- master clock ----------------
  now() { return Date.now(); }
  // A monotonic timestamp (ms) in the orchestrator's OWN clock domain, for event
  // instrumentation. NOT comparable across process/clock domains (iPad, room-audio,
  // sidecar), each domain's monotonic clock is independent; alignment is via the
  // shared master (wall) clock, with the documented uncertainty. Never Date.now-only.
  _mono() { try { return +perf.now().toFixed(3); } catch (e) { return null; } }

  // map a master-clock timestamp onto the EEG session timeline (seconds)
  eegTimeOf(masterT) {
    if (this.timeline.streamEpoch == null) return null;
    return +((masterT - this.timeline.streamEpoch) / 1000).toFixed(2);
  }

  // ---------------- beat transitions ----------------
  setBeat(beat, extra = {}) {
    if (!BEATS.includes(beat) || beat === this.beat) return;
    const prev = this.beat;
    this.beat = beat;
    this._armWatchdog(); // every beat change starts a fresh inactivity budget
    if (beat === 'fit') this._armFitHint();
    else if (prev === 'fit') { this._clearFitHint(); this._fitSlow = false; } // the notice dies with the beat
    // The stall detector only runs where a live stream is expected. Entering a
    // streaming beat clears any stale liveness from the previous one, so the
    // first frame of the new stream starts the clock rather than an old frame
    // instantly reading as a dropout.
    if (this._streamingBeat()) {
      if (!this._streamingBeatWas) { this._lastFrameAt = null; this._eegDown = false; this._gapOpenT = null; }
      this._startStallWatch();
    } else {
      this._stopStallWatch();
      if (this._eegDown) { this._eegDown = false; this._gapOpenT = null; }
    }
    this._streamingBeatWas = this._streamingBeat();
    this.log(`beat: ${prev} → ${beat}`);
    this._broadcastState(extra);
    this.emit('beat', { beat, prev, surface: TV_SURFACE[beat] });
  }

  _broadcastState(extra = {}) {
    this.server.broadcast(SERVER.SESSION_STATE, {
      beat: this.beat,
      surface: TV_SURFACE[this.beat],
      archetype: this.answers.archetype,
      // the chosen reading rides canonical state for the same reason archetype
      // does: an iPad that reloads mid-session rejoins with fresh React state,
      // and without this it lands on the Reading screen showing "Your piece
      // loads here" instead of the guest's piece. Only the descriptor travels;
      // the body text is looked up client-side by id, exactly as a live tap does.
      reading: this.answers.reading || null,
      // the signal-check verdict rides canonical state: the streaming fit has
      // no impedance messages, so this flag is how the iPad + TV learn the
      // read is clean (dropping it left the iPad on "finding a clean read…").
      fitAllGood: this._fitAllGood,
      // coaching notices are canonical state, not one-shot extras, every
      // rebroadcast (resync, supervisor-ready) must carry them while they hold.
      notice: this._notice(),
      link: this._linkState(),
      // correction 1: honest signal eligibility (transport vs analysis vs one/both
      // ears) + the visible staff-override flag. Never a number.
      signal: this._signalEligibilitySummary(),
      staffOverride: !!this._staffOverride,
      ...extra,
    });
  }

  // GUEST-FACING COACHING IS OFF. The room never tells a guest about the state of
  // their signal, not "signal lost", not "reseat", not "we're still checking". A
  // guest can do nothing useful with a signal verdict, and being told their brain
  // isn't reading properly is the opposite of the experience. The same information
  // now goes to the OPERATOR instead (see _coachOps), who can quietly help.
  // Kept as a function (every broadcast calls it) so the contract is unchanged.
  _notice() {
    return null;
  }

  // Operator-only coaching. Computes a short, actionable prompt, which bud to
  // adjust and what to say to the guest, and sends it to the 'ops' role ONLY.
  // Carries NO raw EEG: just a side, a reason word, and a suggested line.
  _coachOps() {
    const e = this._eegEligibility;
    let side = null, reason = null;
    const lo = this._loffOff;
    if (this._eegDown) { side = 'both'; reason = 'link'; }
    else if (lo && (lo.left || lo.right)) {
      // measured contact beats inferred contact
      side = (lo.left && lo.right) ? 'both' : (lo.left ? 'left' : 'right');
      reason = 'contact';
    }
    else if (e && e.ears) {
      const l = !!(e.ears.left && e.ears.left.usable), r = !!(e.ears.right && e.ears.right.usable);
      if (!l && !r) { side = 'both'; reason = 'contact'; }
      else if (!l) { side = 'left'; reason = 'contact'; }
      else if (!r) { side = 'right'; reason = 'contact'; }
    }
    const key = side ? `${side}:${reason}` : 'none';
    if (key === this._coachKey) return;          // only speak when the advice changes
    this._coachKey = key;
    const SAY = {
      left: 'Ask them to gently push the LEFT earbud in and settle, no need to mention the signal.',
      right: 'Ask them to gently push the RIGHT earbud in and settle, no need to mention the signal.',
      both: 'Ask them to settle both earbuds and sit still for a moment, keep it casual.',
    };
    const payload = side
      ? { active: true, side, reason, say: SAY[side], t: this.now() }
      : { active: false, side: null, reason: null, say: null, t: this.now() };
    try { this.server.broadcast('ops/coach', payload, 'ops'); } catch (_) {}
  }

  // Can we currently reach the guest's iPad? A server that doesn't track
  // presence can't tell us, and this is resilience code, it must never itself
  // become the thing that fails. Unknown means "assume reachable", which is the
  // behaviour that existed before any of this.
  _guestReachable() {
    if (!this.server || typeof this.server.hasRole !== 'function') return true;
    return this.server.hasRole('ipad');
  }

  // What the surfaces need to render a calm, honest connection state. Never an
  // error code: 'holding' means the room is waiting, not that anything failed.
  _linkState() {
    return {
      eeg: this._eegDown ? 'holding' : (this._lastFrameAt ? 'live' : 'waiting'),
      buds: this._budsConnected,
      guest: this._guestReachable(),
      // TRUE only on a real, total loss mid-session: the one condition the
      // room is allowed to name to a guest, with a full cover asking for the
      // operator. Signal QUALITY is still never mentioned anywhere.
      lost: !!(this._eegDown && this._eegSimulation === false
        && ['fit', 'intake', 'picker', 'reading', 'strongest'].includes(this.beat)),
    };
  }

  // ---------------- client (iPad) messages ----------------
  onClientHello({ role, clientTime }) {
    // ONLY a guest (iPad) hello counts as guest activity. A TV or operator
    // console reconnecting must not refresh the abandonment budget, otherwise
    // an operator refreshing their browser keeps a genuinely-abandoned session
    // alive indefinitely.
    if (role !== 'ipad') { this._resync(); return; }
    this._touchWatchdog();
    // sync handshake: hand the iPad the master time alongside its own
    this.server.broadcast(SERVER.SYNC,
      { serverTime: this.now(), clientTime: clientTime ?? this.now() }, 'ipad');
    // a guest has arrived → start a fresh session if idle
    if (this.beat === 'idle') {
      this.reset();
      this.setBeat('welcome');
    } else {
      this._resync();
    }
  }

  _resync() { this._broadcastState(); }

  // Phase 2A.2 correction 2: the room-audio host reports its DUCK marker back, the
  // duck's scheduled Web-Audio clock time + a monotonic estimate of audible onset, in
  // the room-audio browser's OWN clock domain. Kept SEPARATE from the visual marker;
  // never merged into a single onset, never used to claim sample-accurate timing.
  onRoomAudioEvent(msg) {
    if (!this.interruptionTiming) return;              // only meaningful after the fire
    const p = (msg && msg.payload) || msg || {};
    const ad = this.interruptionTiming.audioDuck;
    if (ad.scheduledAudioContextTime != null) return;  // first report wins (one duck per fire)
    if (typeof p.scheduledAudioContextTime === 'number') ad.scheduledAudioContextTime = p.scheduledAudioContextTime;
    if (typeof p.estimatedStartMonotonicMs === 'number') ad.estimatedStartMonotonicMs = p.estimatedStartMonotonicMs;
    else if (typeof p.requestMonotonicMs === 'number') ad.estimatedStartMonotonicMs = p.requestMonotonicMs;
    if (typeof p.baseLatency === 'number') ad.baseLatencySec = p.baseLatency;
    if (typeof p.outputLatency === 'number') ad.outputLatencySec = p.outputLatency;
    ad.reportReceivedMonotonicMs = this._mono();
    this._record('audio_ducked', this.now(), { scheduledAudioContextTime: ad.scheduledAudioContextTime });
    this.log(`room-audio duck reported (audio-clock ${ad.scheduledAudioContextTime}s), separate marker, not a sample-accurate onset`);
  }

  onClientMessage(msg, role) {
    // Only the guest's iPad drives the FSM, any other LAN client (a stray
    // laptop on the room network, a TV surface, a probe) is ignored. The role
    // check comes FIRST: only GUEST activity may refresh the abandonment
    // budget (same invariant as onClientHello), or a chattering non-guest
    // client keeps a genuinely abandoned session alive indefinitely.
    if (role !== 'ipad') return;
    this._touchWatchdog(); // any guest message counts as activity
    // A real guest tapping through takes over from the sim demo autopilot.
    // AUTOMATIC page events don't count: a passive kiosk iPad following the
    // demo-driven beats fires reading_started/reading_scroll on its own, and
    // yielding on those killed the attract loop one beat into its first cycle
    // whenever the room's iPad was simply sitting on the wall.
    if (this._demoActive && !this._demoSending) {
      const autoEvent = msg.type === CLIENT.GUEST_EVENT
        && (msg.kind === GUEST_EVENT.READING_STARTED || msg.kind === GUEST_EVENT.READING_SCROLL);
      if (!autoEvent) { this._demoStop(); this.log('demo: real guest input, autopilot yielding'); }
    }
    this._uiCue(msg); // serene select-sound for accepted taps (never mid-session)
    if (msg.type === CLIENT.GUEST_INTAKE) return this._onIntake(msg);
    if (msg.type === CLIENT.GUEST_EVENT) return this._onGuestEvent(msg);
  }

  // Console-menu sound cue: broadcast ui/cue for exactly the inputs the FSM will
  // accept in the CURRENT beat, and only in the beginning/end beats. The reading
  // and the strongest-stretch pause stay free of UI sounds (only the adaptive
  // music breathes there); mirrors the transition table in _onGuestEvent.
  _uiCue(msg) {
    const accepted =
      (msg.type === CLIENT.GUEST_INTAKE &&
        (this.beat === 'intake' || (this.beat === 'picker' && msg.reading))) ||
      (msg.type === CLIENT.GUEST_EVENT && ({
        idle: [GUEST_EVENT.EARBUD_SEATED],         // a new guest starting a session
        welcome: [GUEST_EVENT.EARBUD_SEATED],
        fit: [GUEST_EVENT.BASELINE_START, GUEST_EVENT.FIT_CONFIRMED], // "I'm ready" is a tap too
        standby: [GUEST_EVENT.REVEAL_ACK],
        email: [GUEST_EVENT.EMAIL_ENTERED],
        close: [GUEST_EVENT.CLOSE_CHOICE],
      }[this.beat] || []).includes(msg.kind));
    if (accepted) this.server.broadcast(SERVER.UI_CUE, { kind: 'select' });
  }

  _onIntake(msg) {
    if (msg.answers) this.answers.intake = msg.answers;
    if (typeof msg.onMind === 'string') this.answers.onMind = msg.onMind;
    if (msg.reading) this.answers.reading = msg.reading;
    this._record('intake', msg.t);

    if (this.beat === 'intake') this.setBeat('picker');
    // Only a reading pick advances out of the picker, a double-fired intake
    // submission (no reading payload) must not start the session early.
    else if (this.beat === 'picker' && msg.reading) {
      // SAFE-POINT PAUSE. If the buds are fully down, starting the reading
      // now would guarantee a skewed session: a blank opening, a late
      // notification, a settle that never got measured. So the room holds at
      // the picker, the iPad shows its held-session cover, the operator gets
      // the alert, and the moment the stream returns the reading begins on
      // its own, because the guest already chose it. Only the start waits.
      if (this._eegDown && this._eegSimulation === false) {
        this._pendingReadingStart = true;
        this.log('reading HELD: earbuds are down, will begin when the stream returns');
        this._coachOps();
        this._broadcastState();
      } else {
        this._beginReading();
      }
    }
  }

  _onGuestEvent(msg) {
    const kind = msg.kind || (msg.payload && msg.payload.type);

    // The iPad's socket stays open from one guest to the next, so a new guest
    // never re-sends client/hello, and idle had no case here, so their very
    // first tap was silently dropped and the room sat wedged until someone
    // reloaded the page. Treat a seat-the-earbud tap at idle as the start of a
    // fresh session. (reset() first: it wipes the event log, so record after.)
    if (this.beat === 'idle' && kind === GUEST_EVENT.EARBUD_SEATED) {
      this.reset();
      this.setBeat('welcome');
      this.log('new guest tapped through at idle, starting a fresh session');
    }
    // scroll samples arrive every few seconds; they belong in scrollTrack, not
    // in the event log, which is meant to stay readable
    if (kind !== GUEST_EVENT.READING_SCROLL) this._record(kind, msg.t, msg.payload);

    switch (this.beat) {
      case 'welcome':
        if (kind === GUEST_EVENT.EARBUD_SEATED) {
          this.setBeat('fit');
          this.sup.send(SIDECAR_IN.CONNECT);
          // the signal check STREAMS live so the guest SEES their α/β/γ waves (not an
          // electrode/impedance readout). Not recorded, streamLog opens at reading.
          this.sup.send(SIDECAR_IN.START_SESSION, { reason: 'signal_check' });
        }
        break;
      case 'fit':
        // the guest is settled and asked for the resting baseline, start
        // capturing. The signal check is already streaming, so this just marks
        // the window; no extra sidecar command is needed.
        if (kind === GUEST_EVENT.BASELINE_START) {
          if (this.baseline) break;   // double-tap must not restart the window
          this.baseline = { startedAt: this.now(), endedAt: null, frames: [], bands: [] };
          this.log(`baseline: capturing ${BASELINE_MS / 1000}s, eyes open`);
          this._broadcastState();
        } else if (kind === GUEST_EVENT.FIT_CONFIRMED) {
          if (this.baseline && !this.baseline.endedAt) {
            this.baseline.endedAt = this.now();
            this.log(`baseline: captured ${this.baseline.frames.length} frames / ${this.baseline.bands.length} band samples`);
          }
          this.sup.send(SIDECAR_IN.STOP_SESSION);   // end the signal-check stream
          this.setBeat('intake');
        }
        break;
      case 'reading':
        if (kind === GUEST_EVENT.READING_STARTED) {
          // already streaming; this just records the guest-perceived start
        } else if (kind === GUEST_EVENT.READING_SCROLL) {
          // Reading pace on the SAME clock as the brain data, so the reveal can
          // put "how you moved through the page" beside "what your rhythms did".
          // Monotonic: a guest scrolling back up must not make the ribbon
          // reverse, which would read as time running backwards.
          const p = Math.max(0, Math.min(1, (msg.payload && msg.payload.p) || 0));
          const last = this.scrollTrack[this.scrollTrack.length - 1];
          this.scrollTrack.push({ t: this._streamT(), p: last ? Math.max(last.p, p) : p });
          // the progress trigger: the guest is deep enough into the piece
          const prog = this.scrollTrack[this.scrollTrack.length - 1].p;
          if (!this.interruptionFired && prog >= INTERRUPT_AT_PROGRESS
            && this._readingStartedAtMs && (this.now() - this._readingStartedAtMs) >= INTERRUPT_MIN_READING_MS) {
            this.log(`interruption: guest is ${Math.round(prog * 100)}% through the piece, firing now`);
            this._fireInterruption();   // keeps its own guards: reading beat, stream up, once only
          }
        } else if (kind === GUEST_EVENT.NOTIFICATION_SHOWN) {
          // the iPad reports the actual rendered-frame time of the notification card
          //, a real (if not sample-accurate) onset. Fills the VISUAL marker only;
          // the audio-duck marker arrives separately (onRoomAudioEvent). The two are
          // never merged into one "exact" timestamp.
          if (this.interruptionTiming && this.interruptionTiming.eventRenderedTime == null) {
            const p = msg.payload || {};
            const shown = p.shownAt || msg.t || this.now();
            const vis = this.interruptionTiming.visual;
            if (typeof p.renderedMonotonicMs === 'number') vis.renderedFrameMonotonicMs = p.renderedMonotonicMs;
            vis.renderReportReceivedMonotonicMs = this._mono();
            vis.timingConfidence = 'low_medium';
            this.interruptionTiming.eventRenderedTime = shown;
            this.interruptionTiming.eventRenderedEegT = this.eegTimeOf(shown);
            this.interruptionTiming.timingMethod = 'ipad_render_report';
            this.interruptionTiming.timingUncertaintyMs = 400;  // real render time; still no sample marker
            this.interruptionTiming.timingConfidence = 'low_medium';
            this._record('notification_shown', shown);
          }
        } else if (kind === GUEST_EVENT.READING_FINISHED) {
          this._clearReadingFallback();
          this.sup.send(SIDECAR_IN.STOP_SESSION); // captures session/samples + archetype
          this.setBeat('strongest');
        }
        break;
      case 'strongest':
        if (kind === GUEST_EVENT.STRONGEST_STRETCH_GUESS) {
          this.answers.strongest = msg.payload && msg.payload.choice;
          this._beginReveal();
        }
        break;
      case 'standby':
        if (kind === GUEST_EVENT.REVEAL_ACK) this._finishReveal();
        break;
      case 'email':
        if (kind === GUEST_EVENT.EMAIL_ENTERED) {
          this.answers.email = msg.payload && msg.payload.email;
          this._saveSession(); // update the record with the captured email
          this.setBeat('close');
        }
        break;
      case 'close':
        if (kind === GUEST_EVENT.CLOSE_CHOICE) {
          // The matched door is known now → send the report to the captured
          // email. A malformed payload records null, not a fabricated
          // 'investor' choice the guest never made (outputs falls back to the
          // investor door copy on its own when the door is unknown).
          this.answers.closeDoor = (msg.payload && msg.payload.door) || null;
          this._saveSession(); // final update: the complete record with door + email
          if (this.answers.email) this.emit('send-report', { reveal: this.reveal, answers: this.answers, email: this.answers.email });
          this.setBeat('idle'); // session ends; ready for the next guest
        }
        break;
    }
  }

  _beginReading() {
    // wall-clock anchor for the progress trigger, so a fast scroller still
    // cannot pull the notification into the settle-in stretch
    this._readingStartedAtMs = this.now();
    this.interruptionFired = false;
    this.timeline = { streamEpoch: null, lastFrame: null };
    // Reset the stream clock's high-water mark and restart offset: the signal
    // check already ran _streamT() (its clock counts from earbud-in, easily
    // minutes), and a sidecar restart mid-reading would otherwise compute
    // _streamOffset from the SIGNAL CHECK's high water instead of the
    // reading's, teleporting the rest of the session far right on the chart.
    this._streamOffset = 0;
    this._maxStreamT = 0;
    // open a fresh full-session recording (stable id → one file, updated in place)
    this.sessionId = this.now();
    this.sessionStartedAt = this.sessionId;
    this.streamLog = { frames: [], bands: [], metrics: [] };
    // Drop anything the SIGNAL CHECK left behind. Stopping that stream makes the
    // sidecar publish its samples + archetype exactly like a real reading; if
    // they survived into here, a lost reading capture would be silently replaced
    // by "the guest fiddling with the earbud" and still read as a clean session.
    this.sessionSamples = null;
    this.answers.archetype = null;
    this.answers.archetypeName = null;
    this.sup.send(SIDECAR_IN.START_SESSION, { reason: 'reading' });
    this.setBeat('reading');
    // fallback: if the line never plateaus, fire at the best high point anyway
    this._clearReadingFallback();
    this._readingFallback = setTimeout(() => {
      if (this.beat === 'reading' && !this.interruptionFired) {
        this.log('no clean plateau, firing interruption at the best high point (fallback)');
        this._fireInterruption();
      }
    }, PLATEAU_FALLBACK_MS);
  }

  _clearReadingFallback() {
    if (this._readingFallback) { clearTimeout(this._readingFallback); this._readingFallback = null; }
  }

  _beginReveal() {
    this.setBeat('standby');             // iPad → dark standby; TV → reveal
    // compute the four reads from the recorded session + the guest's answers
    const bandStream = (this.streamLog && this.streamLog.bands) || [];
    // correction 1: EEG-derived guest claims require the session to be reveal-eligible
    // AND not staff-overridden. A staff-overridden session (or, in REAL mode, one that
    // never reached reveal eligibility) still walks the room, but the reveal presents
    // NO EEG-derived numbers and no "measured" archetype. Simulation is exempt from the
    // reveal-eligibility gate (a known-input demonstration of the room's output); staff
    // override applies in every mode.
    const revealElig = this._eegEligibility ? !!this._eegEligibility.revealEligible : true;
    const realIneligible = !!(this._eegEligibility && this._eegSimulation === false && !revealElig);
    const eegClaimsAllowed = !this._staffOverride && !realIneligible;
    this.sessionDataQualityStatus = this._staffOverride
      ? 'invalid-for-eeg-interpretation'
      : (realIneligible ? 'insufficient-usable-data' : 'ok');
    this.reveal = computeReads({
      samples: this.sessionSamples, answers: this.answers,
      interruptEegT: this.interruptEegT, signalIssue: this.signalIssue,
      bands: bandStream,
      // the fifteen still seconds the guest already sits through. Until now the
      // room recorded them and then used them for nothing, while telling the guest
      // that everything is measured against their own baseline. Now it is.
      baseline: this.baseline,
      eegClaimsAllowed, dataQualityStatus: this.sessionDataQualityStatus,
    });
    // stamp the final policy decision on the reveal so every downstream surface
    // (card, profile, email, record) honours it.
    this.reveal.eegDerivedClaimsAllowed = eegClaimsAllowed;
    this.reveal.revealEligible = eegClaimsAllowed;
    this.reveal.dataQualityStatus = this.sessionDataQualityStatus;
    this.reveal.staffOverride = !!this._staffOverride;
    if (this.reveal.archetype) {
      this.answers.archetype = this.reveal.archetype.label;
      this.answers.archetypeName = this.reveal.archetype.name;
    }
    // Phase 2A: fold the measured event-timing record into the reveal's timing
    // (reads.js provides the metric/confidence defaults; this adds the real
    // request/rendered times and method upgrade).
    if (this.interruptionTiming) this.reveal.timing = Object.assign({}, this.reveal.timing, this.interruptionTiming);
    this.log(`reveal: ${this.reveal.archetype ? this.reveal.archetype.name : '(no archetype)'}${this.reveal.flat ? ' (flat session)' : ''}${this.signalIssue ? ' (signal issue)' : ''}`);
    // results are processed → the card auto-prints + the profile renders now
    this.emit('process-outputs', { reveal: this.reveal, answers: this.answers });
    this._saveSession();   // the full session (reads, focus line, band stream) is saved to disk now

    // A brief, HONEST processing moment before the reveal: the room reads the
    // session, cleaning noise, deriving the focus signal, shaping the four reads
    // from the bands, and the TV says so, so the numbers land as considered
    // rather than instant. The compute above is fast; this is the pause that
    // frames it. (FOCUSROOM_PROCESS_MS=0 in tests to skip the wait.)
    this.server.broadcast(SERVER.REVEAL_PROCESSING, { archetype: this.reveal.archetype });
    this.revealStep = 0;
    this.revealShown = false;   // main.js re-sends by this: processing vs data
    this._clearReveal();
    const showReveal = () => {
      this.revealShown = true;
      this.server.broadcast(SERVER.REVEAL_DATA, this.revealPayload());
      this._stepReveal();
    };
    if (PROCESS_MS > 0) this._processTimer = setTimeout(showReveal, PROCESS_MS);
    else showReveal();
  }

  _stepReveal() {
    this.revealStep += 1;
    if (this.revealStep > REVEAL_STEPS) { this._finishReveal(); return; }
    this.server.broadcast(SERVER.REVEAL_STEP, { index: this.revealStep });
    this.log(`reveal step ${this.revealStep}/${REVEAL_STEPS}`);
    this.revealTimer = setTimeout(() => this._stepReveal(), REVEAL_STEP_MS);
  }

  _finishReveal() {
    this._clearReveal();
    if (this.beat === 'standby') {
      this.setBeat('email');
      // the guest's dot joins the wall in the moment, the TV is now showing
      // the constellation, so they watch it land.
      this.emit('dot-join', { archetype: this.answers.archetype });
    }
  }

  _clearReveal() {
    if (this._processTimer) { clearTimeout(this._processTimer); this._processTimer = null; }
    if (this.revealTimer) { clearTimeout(this.revealTimer); this.revealTimer = null; }
  }

  // The ONE canonical reveal payload. The TV loads tv-reveal.html only once the
  // beat turns standby, so it always misses the first broadcast and depends on
  // main.js re-sending this on its client-hello. Both paths call this builder,
  // a second hand-written copy silently lost `bands` (the reveal's hero visual)
  // and shipped a slideshow of empty charts.
  revealPayload() {
    const r = this.reveal || {};
    return {
      samples: r.samplesForReveal || this.sessionSamples || [],
      bands: (this.streamLog && this.streamLog.bands) || [], // whole-session 5-band stream
      reads: r.reads || [],                                 // each carries a band-based note
      archetype: r.archetype,
      interruptT: r.interruptT,
      flat: r.flat,
      scroll: this.scrollTrack || [],
      // stretches with no signal at all. The chart MUST break its lines here:
      // interpolating across a Bluetooth dropout draws a clean, confident line
      // through a window where nothing was recorded.
      gaps: this._streamGaps || [],
    };
  }

  // ---------------- full-session recording ----------------
  // Seconds into the recorded stream. Prefer the EEG frame clock; before the
  // first frame lands (brainwaves can arrive first) fall back to wall time since
  // the reading opened, so a sample is never stamped null, a null t collapsed
  // that point onto x=0 in the reveal chart.
  // The session clock, in seconds since the reading began. lastFrame.tRel is
  // already offset-corrected (see the FRAME handler), so this stays continuous
  // across a sidecar restart or a Bluetooth dropout instead of snapping back to
  // zero and stacking the rest of the session on top of its own opening.
  _streamT() {
    let t = 0;
    if (this.timeline.lastFrame) t = this.timeline.lastFrame.tRel;
    else if (this.sessionStartedAt) t = (this.now() - this.sessionStartedAt) / 1000;
    if (t > this._maxStreamT) this._maxStreamT = t;
    return +t.toFixed(2);
  }

  // Capture the resting baseline: only during the fit beat, only while the
  // window is open, and only for BASELINE_MS. This is the guest's own quiet
  // reference, every later read is expressed against it.
  _recordBaseline(kind, obj) {
    const b = this.baseline;
    if (!b || b.endedAt || this.beat !== 'fit') return;
    const dt = this.now() - b.startedAt;
    if (dt > BASELINE_MS) { b.endedAt = b.startedAt + BASELINE_MS; return; }
    const arr = b[kind];
    // Stamp t as seconds INTO THE BASELINE (0…15). The signal-check stream's
    // own tRel counts from whenever the earbud went in, so a guest who spent
    // 90s seating it would otherwise get a "baseline" running 90→105, on a
    // clock the record doesn't even persist, making it useless as a reference.
    if (arr && arr.length < 4000) arr.push(Object.assign({}, obj, { t: +(dt / 1000).toFixed(2) }));
  }

  // capture the live stream during the actual reading only (not fit/idle streaming),
  // bounded so a very long reading can't grow unbounded.
  _recordStream(kind, obj) {
    if (!this.streamLog || (this.beat !== 'reading' && this.beat !== 'strongest')) return;
    const arr = this.streamLog[kind];
    // ~27h at 1/s: never truncates a real reading (the whole session's EEG is saved),
    // while still guarding against a runaway stream.
    if (arr && arr.length < 100000) arr.push(obj);
  }

  // Assemble the complete session record, everything the room produced.
  _sessionRecord() {
    const a = this.answers, r = this.reveal || {};
    return {
      id: this.sessionId,
      startedAt: this.sessionStartedAt,
      savedAt: this.now(),
      archetype: { label: a.archetype, name: a.archetypeName },
      archetypeFeatures: r.archetype || null,      // settle / variability / raw features
      intake: a.intake || {},                       // the three belief answers
      onMind: a.onMind || '',
      reading: a.reading || null,                   // the piece the guest chose
      strongestGuess: a.strongest || null,
      closeDoor: a.closeDoor || null,
      email: a.email || null,
      flat: !!r.flat,
      signalIssue: !!this.signalIssue,
      // correction 1: honest data-quality provenance for the whole session record.
      // 'invalid-for-eeg-interpretation' ⇒ staff/demonstration override (never labelled
      // "measured"); 'insufficient-usable-data' ⇒ real signal never reached reveal
      // eligibility; 'ok' ⇒ reveal-eligible. staffOverride is the explicit flag.
      dataQualityStatus: this.sessionDataQualityStatus || (r.dataQualityStatus || null),
      staffOverride: !!this._staffOverride,
      eegDerivedClaimsAllowed: r.eegDerivedClaimsAllowed !== false,
      interruptT: r.interruptT != null ? r.interruptT : null,
      interruptEegT: this.interruptEegT,
      interruptionTiming: this.interruptionTiming || null,  // Phase 2A event-timing record
      reads: r.reads || null,                       // the four reads
      stats: r.stats || null,                       // the measured figures the reveal quoted
      scroll: this.scrollTrack || [],               // reading pace, on the EEG clock
      gaps: this._streamGaps || [],                 // stream-clock stretches with no signal
      events: this.events || [],                    // guest events on the EEG timeline
      focusLine: this.sessionSamples || [],         // the relative engagement line (t, v, vr)
      stream: this.streamLog || null,               // live frames / bands / metrics, full session, uncapped
      baseline: this.baseline || null,              // the 15s eyes-open resting reference
      impedance: this.impedanceLog || [],           // contact-density history from the signal check
    };
  }

  // Persist the record. Emitted (not written directly) so main.js owns the store;
  // called at the reveal (core data ready) and again as email/door fill in, the
  // stable id means each save updates the same file.
  _saveSession() {
    if (this.sessionId == null) return;
    try { this.emit('session-record', this._sessionRecord()); }
    catch (e) { this.log(`session-record emit failed: ${e.message}`); }
  }

  // ---------------- EEG stall detector (Bluetooth) ----------------
  // A Bluetooth drop does not announce itself. The sidecar process stays up, no
  // socket closes, no error is raised anywhere, the frames simply stop, and
  // every signal-quality check we have is driven BY frames, so silence used to
  // be completely invisible. The line on the wall would freeze mid-session and
  // nothing, anywhere, would notice.
  //
  // This watches for that silence and treats it as a pause: mark the gap, tell
  // the surfaces to say something calm, and change nothing else. The beat does
  // not advance, the session is not touched, and the SDK's own auto-reconnect
  // is left to do its work.
  _startStallWatch() {
    if (this._stallTimer) return;
    this._stallTimer = setInterval(() => this._checkStall(), EEG_STALL_TICK_MS);
    if (this._stallTimer.unref) this._stallTimer.unref();
  }

  _stopStallWatch() {
    if (this._stallTimer) { clearInterval(this._stallTimer); this._stallTimer = null; }
  }

  // Only the beats that depend on a live stream can stall. Everywhere else a
  // quiet sidecar is simply correct.
  _streamingBeat() { return this.beat === 'fit' || this.beat === 'reading'; }

  _checkStall() {
    if (!this._streamingBeat() || this._lastFrameAt == null || this._eegDown) return;
    if (this.now() - this._lastFrameAt < EEG_STALL_MS) return;
    this._eegDown = true;
    this.signalIssue = true;              // sticky: the reveal leans on clean stretches
    this._gapOpenT = this._streamT();     // the data has a hole from here
    this._broadcastState();
    this._coachOps();
    this.log(`EEG stream went quiet in '${this.beat}', holding the session and waiting for the link`);
  }

  // Any frame proves the link is alive again. Closing the gap here (rather than
  // on a connection message) means it works for every cause of silence: a
  // Bluetooth drop, a sidecar restart, or the SDK quietly re-pairing.
  _onStreamAlive() {
    this._lastFrameAt = this.now();
    if (!this._eegDown) return;
    this._eegDown = false;
    // a reading held at the safe point starts itself once the stream is back
    if (this._pendingReadingStart && this.beat === 'picker') {
      this._pendingReadingStart = false;
      this.log('stream returned, beginning the held reading');
      this._beginReading();
    }
    if (this._gapOpenT != null) {
      const gap = { from: this._gapOpenT, to: this._streamT() };
      // only record a gap the analysis should actually skip over
      if (gap.to - gap.from >= 1) this._streamGaps.push(gap);
      this._gapOpenT = null;
      this.log(`EEG stream resumed, ${(gap.to - gap.from).toFixed(1)}s gap recorded`);
    } else {
      this.log('EEG stream resumed');
    }
    this._broadcastState();
    this._coachOps();
  }

  // ---------------- guest link (Wi-Fi) ----------------
  // The iPad dropping off the network is not the guest leaving. Both look
  // identical to the watchdog, silence, so it needs to be told the difference.
  onClientLeft(role) {
    if (role === 'ipad' && !this._guestReachable()) {
      this._linkLostAt = this.now();
      this.log('the iPad went off the network, holding the session until it returns');
      this._broadcastState();
    }
  }

  onClientRejoined(role) {
    if (role !== 'ipad' || this._linkLostAt == null) return;
    const downMs = this.now() - this._linkLostAt;
    this._linkLostAt = null;
    this._record('link_restored', this.now(), { downMs });
    this.log(`the iPad is back after ${Math.round(downMs / 1000)}s, resuming where the session stood`);
    this._broadcastState();
  }

  // ---------------- abandonment watchdog ----------------
  _watchdogBudget(beat) {
    const override = parseInt(process.env.FOCUSROOM_IDLE_RESET_MS || '', 10);
    if (Number.isFinite(override) && override > 0) return override; // test knob: one budget for every beat
    const budget = WATCHDOG_BUDGET_MS[beat] || null;
    // a long FOCUSROOM_REVEAL_STEP_MS must never let the watchdog kill a live
    // reveal, standby's budget always covers the full paced reveal plus slack.
    if (beat === 'standby' && budget != null) {
      return Math.max(budget, REVEAL_STEPS * REVEAL_STEP_MS + 120000);
    }
    return budget;
  }

  _armWatchdog() {
    this._clearWatchdog();
    const budget = this._watchdogBudget(this.beat);
    if (budget == null) return; // idle: nothing to abandon
    this._watchdog = setTimeout(() => this._abandonSession(budget), budget);
  }

  _touchWatchdog() {
    if (this.beat === 'idle') return;
    this._armWatchdog();
  }

  _clearWatchdog() {
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
  }

  // The guest walked away mid-flow: stop whatever the beat had running, wipe the
  // session, and hand the room back to idle so the next hello starts fresh.
  // (Timing note: _beginReveal enters standby BEFORE the reveal compute/output
  // work, so the fresh 8-minute standby budget always covers that processing.)
  _abandonSession(budgetMs) {
    this._watchdog = null;
    if (this.beat === 'idle') return;
    // A DROPPED LINK IS NOT AN ABSENT GUEST. The budget measures guest
    // inactivity, and it can only measure that while the guest is reachable,
    // an iPad off the Wi-Fi looks exactly like someone who walked out. Before
    // this guard, a router blip during the reading wiped a live session,
    // discarded the recorded EEG and sent the room back to idle with a guest
    // still sitting in it wearing the buds. Hold instead, and re-arm.
    if (!this._guestReachable()) {
      const downFor = this._linkLostAt ? this.now() - this._linkLostAt : 0;
      if (downFor < LINK_LOST_CEILING_MS) {
        this.log(`watchdog: budget elapsed in '${this.beat}' but the iPad is unreachable, holding the session, not abandoning it`);
        this._armWatchdog();
        return;
      }
      this.log(`watchdog: nothing has come back for ${Math.round(downFor / 60000)} min, reclaiming the room`);
    }
    const beat = this.beat;
    this.log(`watchdog: no guest activity in '${beat}' for ${Math.round(budgetMs / 1000)}s, abandoning the session`);
    this._record('session_abandoned', this.now(), { beat, budgetMs }); // diag trail
    // fit now STREAMS (the signal check), so stopping it is STOP_SESSION like the reading
    if (beat === 'fit' || beat === 'reading' || beat === 'strongest') this.sup.send(SIDECAR_IN.STOP_SESSION);
    this._clearSession(); // answers, reveal, revealStep, timers, signal flags
    this.setBeat('idle'); // TV back to the constellation; the next hello starts fresh
  }

  // ---------------- fit escalation ----------------
  // If no allGood impedance snapshot arrives within the hint window, surface the
  // canonical 'fit_slow' notice, cleared the moment an allGood lands or the
  // beat leaves fit. (The iPad copy consuming it lands separately.)
  // Entering the signal check arms a SETTLE, not a gate: after a short beat the room
  // is ready regardless of what the signal is doing. Nothing here inspects quality.
  _armFitHint() {
    this._clearFitHint();
    this._fitAllGood = false;
    this._fitSlow = false;
    this._fitHint = setTimeout(() => {
      this._fitHint = null;
      if (this.beat !== 'fit' || this._fitAllGood) return;
      this._fitAllGood = true;                 // ready, never conditional on the signal
      this._broadcastState();
      this.log(`signal check: settled after ${Math.round(FIT_SETTLE_MS)}ms, ready (not gated on signal quality)`);
    }, FIT_SETTLE_MS);
  }

  _clearFitHint() {
    if (this._fitHint) { clearTimeout(this._fitHint); this._fitHint = null; }
  }

  _onImpedance(msg) {
    if (this.beat !== 'fit' || !msg.allGood) return;
    this._fitAllGood = true;
    this._clearFitHint();
    if (this._fitSlow) {
      this._fitSlow = false;
      this._broadcastState();
      this.log('fit: allGood arrived, fit_slow cleared');
    }
  }

  // ---------------- sidecar restart ----------------
  // Commands are fire-and-forget: a supervisor restart mid-beat leaves fit or
  // reading silently dead. Re-issue what the current beat depends on. Wired from
  // main.js's supervisor 'ready' handler, which also fires on first boot, when
  // the beat is idle and this is a no-op.
  onSidecarReady() {
    switch (this.beat) {
      case 'fit':
        this.log('sidecar restarted during signal check, re-issuing CONNECT + START_SESSION');
        this.sup.send(SIDECAR_IN.CONNECT); // real-mode connects take seconds; the sidecar handles ordering
        this.sup.send(SIDECAR_IN.START_SESSION, { reason: 'signal_check' });
        break;
      case 'reading':
        this.log('sidecar restarted during reading, re-issuing START_SESSION; the timeline has a gap');
        this.signalIssue = true; // sticky: the reveal already leans on the clean data
        // Carry the session clock across the restart. The fresh stream's tRel
        // reopens at 0, so without this every post-restart sample lands back at
        // the start of the chart, stacked on top of the session's own opening.
        // Carry the clock forward by the wall time actually lost, not just to
        // where it stopped: those seconds happened to the guest, and a reveal
        // that quietly closes the gap would misplace everything after it.
        {
          const lostSec = this._lastFrameAt ? Math.max(0, (this.now() - this._lastFrameAt) / 1000) : 0;
          this._streamOffset = this._maxStreamT + lostSec;
        }
        this.timeline = { streamEpoch: null, lastFrame: null }; // re-anchor on the fresh stream
        this.sup.send(SIDECAR_IN.START_SESSION, { reason: 'sidecar_restart' });
        break;
      case 'strongest':
        // the reading already ended (STOP_SESSION ran at reading_finished), an
        // orphan START_SESSION here would stream into nothing and, in sim, make
        // the NEXT guest's start hit the re-entrancy guard and skip the engine
        // reset. Only flag trouble if the crash beat the session capture.
        if (this.sessionSamples == null) {
          this.log('sidecar restarted during strongest, session samples were lost; reveal falls back');
          this.signalIssue = true; // reads.js already handles null samples via the minimal path
        } else {
          this.log('sidecar restarted during strongest, session already captured; nothing to re-issue');
        }
        break;
      default:
        break; // idle/welcome/intake/picker/standby/email/close: nothing was streaming
    }
  }

  // ---------------- sidecar messages ----------------
  onSidecar(msg) {
    switch (msg.type) {
      case SIDECAR_OUT.FRAME: {
        // anchor the EEG timeline: streamEpoch = frame master time − tRel.
        // tRel is shifted by _streamOffset so a restarted stream continues the
        // session clock rather than reopening it at zero.
        const tRel = typeof msg.tRel === 'number' ? +(msg.tRel + this._streamOffset).toFixed(3) : null;
        if (tRel != null && typeof msg.t === 'number') {
          if (this.timeline.streamEpoch == null) this.timeline.streamEpoch = msg.t - tRel * 1000;
          this.timeline.lastFrame = { tRel, t: msg.t };
        }
        // A frame is also the proof the link is alive. Called AFTER the timeline
        // update so a gap being closed can be measured to the RESUMING frame,
        // measuring it before left every gap exactly zero seconds long.
        this._onStreamAlive();
        this._recordStream('frames', { t: tRel, v: msg.engagementRel, w: msg.stateWord || null });
        this._recordBaseline('frames', { t: tRel, v: msg.engagementRel, q: msg.signalQuality });
        this._watchSignal(msg);
        this._watchFitSignal(msg);
        break;
      }
      case SIDECAR_OUT.LEADOFF: {
        // Live electrode contact, straight off the wire. This is a HARDER fact
        // than the statistical eligibility the coach otherwise runs on: a set
        // lead-off bit means that pin is physically off the skin, so when it is
        // available it should lead. Held for three consecutive reports before it
        // speaks, so a single bad packet cannot send an operator across the room.
        const sides = msg.sides || {};
        const offNow = {};
        ['left', 'right'].forEach((sd) => {
          const chs = sides[sd] || {};
          offNow[sd] = Object.keys(chs).length > 0 && Object.keys(chs).every((k) => chs[k].off);
        });
        this._loffRun = this._loffRun || { left: 0, right: 0 };
        ['left', 'right'].forEach((sd) => {
          this._loffRun[sd] = offNow[sd] ? this._loffRun[sd] + 1 : 0;
        });
        this._loffOff = { left: this._loffRun.left >= 3, right: this._loffRun.right >= 3 };
        this._coachOps();
        break;
      }
      case SIDECAR_OUT.BRAINWAVES:
        // Record ONLY once the frame clock has anchored the timeline. Brainwaves
        // can beat the first frame in, and _streamT's wall-clock fallback stamped
        // that early row at ~2.4s before the stream clock restarted at 0, a
        // stray opening row that forked the reveal chart's left edge. Dropping a
        // pre-anchor row loses ≤2s of a 1–2Hz stream; mis-stamping it lies.
        if (this.timeline.lastFrame) {
          this._recordStream('bands', { t: this._streamT(), delta: msg.delta, theta: msg.theta,
            alpha: msg.alpha, beta: msg.beta, gamma: msg.gamma, engIndex: msg.engIndex,
            // schema 2: dB above this guest's own fitted 1/f background. Every
            // guest-facing figure is built from this, never from the shares above,
            // which exist only so unmigrated surfaces keep working.
            ...(msg.bandsSchema ? { bandsSchema: msg.bandsSchema, osc: msg.osc, ap: msg.ap } : {}) });
        }
        this._recordBaseline('bands', { t: this._streamT(), delta: msg.delta, theta: msg.theta,
          alpha: msg.alpha, beta: msg.beta, gamma: msg.gamma,
          ...(msg.bandsSchema ? { bandsSchema: msg.bandsSchema, osc: msg.osc } : {}) });
        break;
      case SIDECAR_OUT.METRICS:
        this._recordStream('metrics', { t: this._streamT(), engagement: msg.engagement, focus: msg.focus,
          stress: msg.stress, mentalReadiness: msg.mental_readiness, drowsiness: msg.drowsiness,
          relaxation: msg.relaxation, wellness: msg.wellness });
        break;
      case SIDECAR_OUT.IMPEDANCE:
        // save the whole contact-density history (fit/signal-check phase) into the record
        if (this.impedanceLog && this.impedanceLog.length < 20000) {
          this.impedanceLog.push({ t: msg.t || this.now(), channels: msg.channels || null, allGood: !!msg.allGood });
        }
        this._onImpedance(msg); // fit escalation tracks the allGood snapshots
        break;
      case SIDECAR_OUT.PLATEAU:
        this._fireInterruption();
        break;
      // The buds themselves connecting or dropping. The SDK runs its own
      // auto-reconnect, so this is reported, recorded and rendered calmly, it
      // never drives a beat change.
      case SIDECAR_OUT.CONNECTION: {
        const was = this._budsConnected;
        this._budsConnected = msg.connected !== false;
        if (was !== this._budsConnected) {
          if (!this._budsConnected) {
            this.signalIssue = true;
            this.log('earbud link dropped, the SDK is reconnecting; the session holds');
            this._record('buds_disconnected', this.now());
          } else if (was === false) {
            // false → true is a genuine restore; null → true is just the FIRST
            // report, which used to pollute every session's event log with a
            // fabricated 'buds_reconnected' for a drop that never happened
            this.log('earbud link restored');
            this._record('buds_reconnected', this.now());
          } else {
            this.log('earbud link up');
          }
          this._broadcastState();
        }
        break;
      }
      case SIDECAR_OUT.ARCHETYPE:
        // Only a real reading produces an archetype. Ending the signal-check
        // stream emits one too (the sidecar can't tell the streams apart), and
        // it would overwrite the guest's archetype with their earbud-seating.
        if (this._preReadingBeat()) break;
        if (msg.label) {
          this.answers.archetype = msg.label;
          this.answers.archetypeName = msg.name || this.answers.archetypeName;
          // let the iPad close screen lead with the real archetype
          this.server.broadcast(SERVER.ARCHETYPE,
            { label: msg.label, name: msg.name, settle: msg.settle, variability: msg.variability });
        }
        break;
      case SIDECAR_OUT.SESSION_SAMPLES:
        // same guard as ARCHETYPE: the signal check's samples are not a reading
        if (this._preReadingBeat()) break;
        this.sessionSamples = msg.samples; // handed to the reveal/card/profile
        break;
      case SIDECAR_OUT.EEG_QUALITY:        // Phase 2A honest signal quality
        this._onEegQuality(msg);
        break;
    }
  }

  // True for every beat before a reading has actually been captured. The signal
  // check streams and stops just like a reading, so its stop emits SESSION_SAMPLES
  // and ARCHETYPE; without this guard a lost reading capture would be quietly
  // backfilled with signal-check data and still present as a clean session
  // (onSidecarReady's `sessionSamples == null` recovery check would never fire).
  _preReadingBeat() {
    return this.beat === 'idle' || this.beat === 'welcome' || this.beat === 'fit'
      || this.beat === 'intake' || this.beat === 'picker';
  }

  // Operator-triggered interruption (the console's "Fire the interruption"
  // button). Routes through the SAME path as the automatic one, so it actually
  // shows the guest the notification card and marks the real EEG timeline,
  // rather than the raw sidecar `mark`, which only annotated the recording and
  // did nothing the guest could see. Returns whether it fired, so the console
  // can tell the operator (it only fires during the reading, once).
  forceInterruption() {
    const before = this.interruptionFired;
    this._fireInterruption();
    return this.interruptionFired && !before;
  }

  _fireInterruption() {
    if (this.beat !== 'reading' || this.interruptionFired) return;
    // Never spend the room's one interruption while the stream is down. The
    // whole point of it is to MEASURE what a notification costs, and with no
    // signal there is nothing to measure, the guest would get the buzz and the
    // reveal would have nothing to say about it. Wait for the link and let the
    // fallback try again.
    // _lastFrameAt == null covers the stream that NEVER produced a frame after
    // entering the reading (a lost START_SESSION, a silent sidecar): the stall
    // detector can't see that case, and the 75s fallback would otherwise spend
    // the room's one interruption with zero signal to measure it against.
    if (this._eegDown || this._lastFrameAt == null) {
      this.log('interruption due, but there is no live EEG signal, deferring until the signal returns');
      this._clearReadingFallback();
      this._readingFallback = setTimeout(() => {
        if (this.beat === 'reading' && !this.interruptionFired) this._fireInterruption();
      }, EEG_STALL_MS);
      return;
    }
    this.interruptionFired = true;
    this._clearReadingFallback();
    const t = this.now();
    const reqMono = this._mono();
    this.interruptEegT = this.eegTimeOf(t); // anchor for the reveal's interruption read
    // Phase 2A.2 event-timing (correction 2): the interruption is a MULTIMODAL event,
    // a VISUAL notification card on the iPad + a ROOM-AUDIO duck. It is NOT earbud audio,
    // so a firmware audio-onset marker is NOT relevant here (a device EEG SAMPLE COUNTER
    // remains desirable for alignment, but the firmware exposes none, audit Q17/18/23).
    // The two markers are captured and kept SEPARATE, never collapsed into one supposed
    // exact timestamp, and never chosen to maximise an apparent EEG effect. The primary
    // marker is PREDECLARED here, before any analysis. No sample-accurate claim is made.
    this.interruptionTiming = {
      eventType: 'combined-visual-card-and-room-audio-duck',
      // VISUAL marker (iPad browser clock): the card's committed paint, reported back
      // by the iPad as `notification_shown` (double-rAF).
      visual: {
        requestWallMs: t, requestMonotonicMs: reqMono, requestClockDomain: 'orchestrator-node',
        renderedFrameMonotonicMs: null, renderReportReceivedMonotonicMs: null,
        renderedClockDomain: 'ipad-browser', clockDomain: 'ipad-browser',
        timingConfidence: 'low',
      },
      // AUDIO-DUCK marker (room-audio browser clock): the duck's scheduled Web-Audio
      // clock time, reported back by room-audio.html as `audio/event kind=ducked`.
      audioDuck: {
        requestWallMs: t, requestMonotonicMs: reqMono,
        scheduledAudioContextTime: null, estimatedStartMonotonicMs: null,
        reportReceivedMonotonicMs: null, clockDomain: 'room-audio-browser',
        timingConfidence: 'low',
      },
      // EEG alignment: no device sample counter exists, so alignment is only the
      // master-clock epoch mapping (eegTimeOf), receive-time, not sample-accurate.
      eegAlignment: {
        deviceSampleCounterAvailable: false, deviceSampleIndex: null,
        sdkCallbackTimeEstimate: null, sidecarMonotonicMs: null,
        clockAlignmentMethod: 'master_clock_epoch_mapping',
        estimatedUncertaintyMs: 1200, timingConfidence: 'low',
      },
      // PREDECLARED intervention marker (fixed before analysis; not cherry-picked):
      primaryMarkerDefinition: 'visual.renderedFrameMonotonicMs, the iPad committed paint of the notification card',
      secondaryMarkers: ['audioDuck.scheduledAudioContextTime', 'visual.requestMonotonicMs'],
      // ---- legacy/compat fields the reveal + record already read ----
      eventRequestTime: t, eventRequestEegT: this.interruptEegT,
      eventRenderedTime: null, eventRenderedEegT: null,
      deviceSampleIndex: null, estimatedPhysicalOnset: null,
      timingMethod: 'app_fire_call',
      timingUncertaintyMs: 1200, // ~1 s emit cadence + 2 s window + transport (provisional)
      timingConfidence: 'low',
      media: ['ipad_visual_card', 'room_audio_duck'],
    };
    this.server.broadcast(SERVER.INTERRUPTION_FIRE, { onMind: this.answers.onMind, t });
    this.sup.send(SIDECAR_IN.MARK, { kind: 'interruption' }); // real dip is whatever the brain does
    this._record('interruption_fired', t);
    this.log(`interruption fired @ EEG t=${this.eegTimeOf(t)}s (onMind: "${this.answers.onMind}")`);
  }

  // Signal-trouble flow (Document.pdf): never show a broken line, the engine
  // keeps the smoothed line flowing; we just coach a small reseat and flag the
  // session so the reveal leans on the clean middle. (A 30s re-read to recapture
  // a lost interruption is the next step if the dip window itself reads unclear.)
  // During the signal check (fit beat, streaming), mark ready once the live signal
  // has held clean for a moment, the honest "signal is clear" gate, from the real
  // signal itself rather than an electrode/impedance readout.
  // The signal check no longer GATES on the signal at all. A live frame simply lets the
  // room settle a touch sooner than the timer; a poor one never holds anyone back.
  // (Previously N clean frames AND analysis eligibility were required, which could lock
  // the room on a marginal fit.) Signal quality now only informs the OPERATOR.
  _watchFitSignal(frame) {
    if (this.beat !== 'fit' || this._fitAllGood) return;
    this._fitGood = (this._fitGood || 0) + 1;
    if (this._fitGood >= 3) {
      this._fitAllGood = true; this._clearFitHint(); this._broadcastState();
      this.log('signal check: stream is live → ready (signal quality is NOT a gate)');
    }
  }

  // Phase 2A / 2A.2: consume the honest per-channel EEG quality (eeg/quality-v1).
  // Drives the fit-ready gate above and lets the signal-check surface show a truthful
  // partial/poor state.
  //
  // CORRECTION 1, receiving raw callbacks alone is NOT sufficient to advance. The
  // fit gate now keys on ANALYSIS ELIGIBILITY (a grossly-usable channel on each ear),
  // not mere packet receipt (transportReady / 'received'). Staff override allows
  // navigation without valid EEG, for demonstrations.
  _onEegQuality(msg) {
    this._eegQualitySeen = true;
    this._eegQualityStatus = msg.overallStatus;
    this._eegEligibility = msg.eligibility || null;
    if (typeof msg.simulation === 'boolean') this._eegSimulation = msg.simulation;
    // Eligibility is still COMPUTED and recorded (engineering + validation evidence and
    // the reveal-claim gate depend on it), it just no longer holds the guest up.
    const analysisOk = !!(this._eegEligibility && this._eegEligibility.analysisEligible);
    this._fitQualityOk = analysisOk || this._staffOverride;
    this._coachOps();      // quality goes to the OPERATOR, never to the guest
    // surface a truthful partial/one-ear/neither-ear state to the iPad + TV, but only
    // when the summary actually changes (quality streams ~3×/s, don't spam state).
    const e = this._eegEligibility;
    const key = e ? `${e.transportReady}|${e.analysisEligible}|${e.eligibilityStatus}|${e.ears.left.usable}|${e.ears.right.usable}` : 'none';
    if (key !== this._eegEligKey) { this._eegEligKey = key; if (this.beat === 'fit') this._broadcastState(); }
  }

  // A compact, honest signal-eligibility summary for the surfaces. Never a number,
  // it tells the iPad/TV whether the room may advance and whether one/both ears read.
  _signalEligibilitySummary() {
    const e = this._eegEligibility;
    if (!e) return this._staffOverride ? { staffOverride: true, status: 'staff-override' } : null;
    return {
      transportReady: !!e.transportReady,
      analysisEligible: !!e.analysisEligible,
      revealEligible: !!e.revealEligible,
      status: e.eligibilityStatus,
      ears: { left: !!(e.ears && e.ears.left && e.ears.left.usable),
        right: !!(e.ears && e.ears.right && e.ears.right.usable) },
      staffOverride: !!this._staffOverride,
    };
  }

  // ---------------- staff / demonstration override (correction 1) ----------------
  // An explicit, staff-only switch. When ON: the room may be walked through without
  // valid EEG (navigation unblocked), but the session is marked invalid for EEG
  // interpretation, it must NOT generate EEG-derived guest claims, and is never
  // labelled "successfully measured". Visible on every surface via session/state.
  setStaffOverride(on, reason) {
    const was = this._staffOverride;
    this._staffOverride = !!on;
    if (this._staffOverride === was) return this._staffOverride;
    this._record(this._staffOverride ? 'staff_override_on' : 'staff_override_off', this.now(), { reason: reason || null });
    this.log(`staff override ${this._staffOverride
      ? 'ENABLED, navigation allowed; session marked invalid-for-eeg-interpretation (no EEG-derived guest claims)'
      : 'cleared, analysis eligibility required again to advance'}`);
    // enabling unblocks the fit gate immediately; disabling re-requires analysis eligibility
    this._fitQualityOk = this._staffOverride
      || !!(this._eegEligibility && this._eegEligibility.analysisEligible);
    this._broadcastState();
    return this._staffOverride;
  }

  _watchSignal(frame) {
    if (this.beat !== 'reading') return;
    const sq = typeof frame.signalQuality === 'number' ? frame.signalQuality : 1;
    if (sq < 0.5) {
      this._lowSqCount += 1;
      if (this._lowSqCount >= 2 && !this._reseatActive) {
        this._reseatActive = true;
        this.signalIssue = true; // sticky for the reveal
        this._broadcastState();
        this.log('signal degraded during reading → reseat prompt');
      }
    } else {
      this._lowSqCount = 0;
      if (this._reseatActive) {
        this._reseatActive = false;
        this._broadcastState();
        this.log('signal recovered → reseat cleared');
      }
    }
  }

  // ---------------- timeline record ----------------
  _record(kind, masterT, payload) {
    if (!kind) return;
    const t = typeof masterT === 'number' ? masterT : this.now();
    const eegT = this.eegTimeOf(t);
    this.events.push({ kind, masterT: t, eegT, payload });
    this.log(`event ${kind} @ master=${t} eeg=${eegT == null ? ', ' : eegT + 's'}`);
    this.emit('event', { kind, masterT: t, eegT, payload });
  }

  // ---------- sim demo autopilot (SIMULATE only) ----------------------------
  // `npm run dev` has no real guest to tap through the iPad, so the TV sits on
  // the idle constellation and nothing streams. When main.js enables the demo
  // (sim builds only), this walks a whole guest session on a loop, signal
  // check → orb reading → band reveal → close → repeat, so every surface shows
  // live example data. The first real iPad tap cancels it (see onClientMessage).
  enableDemo() { this._demoEnabled = true; }
  _demoDo(fn) { this._demoSending = true; try { fn(); } finally { this._demoSending = false; } }
  _demoStop() { this._demoTimers.forEach(clearTimeout); this._demoTimers = []; this._demoActive = false; }
  startDemo() {
    if (!this._demoEnabled || this.beat !== 'idle' || this._demoActive) return;
    this._demoActive = true;
    this.log('demo: attract-loop auto-driving a full sim session (opt-in via FOCUSROOM_DEMO=1; any real tap takes over)');
    const ev = (kind, payload) => this._demoDo(() =>
      this.onClientMessage({ type: CLIENT.GUEST_EVENT, kind, payload: payload || {}, t: this.now() }, 'ipad'));
    const intake = (fields) => this._demoDo(() =>
      this.onClientMessage(Object.assign({ type: CLIENT.GUEST_INTAKE, t: this.now() }, fields), 'ipad'));
    const hello = () => this._demoDo(() => this.onClientHello({ role: 'ipad', clientTime: this.now() }));
    // [delay-from-previous-step (ms), action]
    const steps = [
      [300,  hello],                                                   // idle → welcome
      [2000, () => ev(GUEST_EVENT.EARBUD_SEATED)],                     // → fit (signal-check waves stream)
      [6500, () => ev('fit_confirmed')],                              // → intake
      [2600, () => intake({ answers: { 0: 'A blip, I barely notice', 1: 'It drifts', 2: 'A few minutes' }, onMind: 'a deadline on Friday' })], // → picker
      [2600, () => intake({ reading: { id: 'octopus', title: 'How an Octopus Thinks', meta: '3 min read' } })], // → reading (orb + START_SESSION)
      [24000, () => ev(GUEST_EVENT.READING_FINISHED)],                  // → strongest (interruption auto-fires mid-reading)
      [3200, () => ev(GUEST_EVENT.STRONGEST_STRETCH_GUESS, { choice: 'The ending' })], // → reveal (bands)
      [22000, () => ev('reveal_ack')],                                 // → email (after a couple reveal slides)
      [3200, () => ev(GUEST_EVENT.EMAIL_ENTERED, { email: 'demo@thefocusroom.local' })], // → close
      [3200, () => ev(GUEST_EVENT.CLOSE_CHOICE, { door: 'customer' })], // → idle
      [5000, () => { this._demoActive = false; this.startDemo(); }],   // loop
    ];
    let acc = 0;
    for (const [ms, fn] of steps) { acc += ms; this._demoTimers.push(setTimeout(fn, acc)); }
  }

  snapshot() {
    return { beat: this.beat, answers: this.answers, events: this.events,
      streamEpoch: this.timeline.streamEpoch, interruptionFired: this.interruptionFired };
  }
}

module.exports = { Orchestrator, BEATS, TV_SURFACE };
