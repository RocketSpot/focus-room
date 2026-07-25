'use strict';
// ============================================================
// Zone — The Focus Room :: MESSAGE CONTRACT (single source of truth)
// ------------------------------------------------------------
// Two links share this vocabulary:
//   1. LAN WebSocket   — Electron main  <->  TV window + iPad client
//   2. localhost TCP   — Electron main  <->  Python sidecar (NDJSON)
//
// The sidecar mirrors these exact strings in sidecar/protocol.py. Keep them
// in lock-step. Every message is a JSON object: { type, t, ...payload } where
// `type` is one of the constants below and `t` is a millisecond timestamp on
// the MASTER CLOCK (Electron main owns it; see sync model in the master prompt).
// ============================================================

// ---- LAN WebSocket: server (main) -> clients (TV / iPad) ----------------
const SERVER = Object.freeze({
  // current beat + substate + which surface shows what
  SESSION_STATE: 'session/state',
  // sync handshake reply to the iPad: { serverTime, clientTime } (master clock)
  SYNC: 'session/sync',
  // the computed archetype (label/name) for the iPad close + outputs
  ARCHETYPE: 'session/archetype',
  // the one calm live line. Driven by metrics.engagement, relative to session.
  // { t, engagementRel (0..1), stateWord, signalQuality }
  EEG_FRAME: 'eeg/frame',
  // link health. { leftConnected, rightConnected, dropRateL, dropRateR, batteryL, batteryR }
  EEG_CONNECTION: 'eeg/connection',
  // pre-check battery gate. { leftPct, rightPct, ok }
  FIT_BATTERY: 'fit/battery',
  // pre-check impedance/seat coaching. { channels:{...}, allGood }
  FIT_IMPEDANCE: 'fit/impedance',
  // tell the iPad to show the interruption card, tied to onMind. { onMind, t }
  INTERRUPTION_FIRE: 'interruption/fire',
  // the reveal payload (sent when the reveal begins): the recorded session
  // samples + the four computed reads + the archetype. { samples, reads, archetype, flat }
  REVEAL_DATA: 'reveal/data',
  REVEAL_PROCESSING: 'reveal/processing',
  // advance the auto-paced TV reveal. { index (1..4) }
  REVEAL_STEP: 'reveal/step',
  // outputs done. { cardPrinted, profileReady, emailSent }
  OUTPUT_READY: 'output/ready',
  // the full constellation for the idle TV wall. { dots:[{archetype,sx,sy}], count, joinId }
  CONSTELLATION_DATA: 'constellation/data',
  // a guest's dot joining the wall in the moment. { dot:{archetype,sx,sy} }
  CONSTELLATION_JOIN: 'constellation/join',
  // a serene UI sound cue for the room audio (console-menu feel). Fired only for
  // accepted guest inputs OUTSIDE the reading — never mid-session. { kind:'select' }
  UI_CUE: 'ui/cue',
  // generic ack/heartbeat
  PONG: 'pong',
});

// ---- LAN WebSocket: clients (iPad) -> server (main), all timestamped -----
const CLIENT = Object.freeze({
  // who am i ("tv" | "ipad" | "diagnostic") — sent on connect for the sync handshake
  HELLO: 'client/hello',
  // { answers:{q1,q2,q3}, onMind, reading, t }
  GUEST_INTAKE: 'guest/intake',
  // { type: <one of the GUEST_EVENT sub-types below>, payload, t }
  GUEST_EVENT: 'guest/event',
  PING: 'ping',
});

// guest/event sub-types (the timestamped beats the iPad reports)
const GUEST_EVENT = Object.freeze({
  EARBUD_SEATED: 'earbud_seated',
  // the guest is settled and has asked to start the 15s resting baseline
  BASELINE_START: 'baseline_start',
  // the signal check + baseline are done — "I'm ready" advances to intake
  FIT_CONFIRMED: 'fit_confirmed',
  READING_STARTED: 'reading_started',
  // how far down the piece the guest has scrolled, sampled while they read
  READING_SCROLL: 'reading_scroll',
  READING_FINISHED: 'reading_finished',
  STRONGEST_STRETCH_GUESS: 'strongest_stretch_guess',
  // the guest tapped through the reveal's end on the iPad
  REVEAL_ACK: 'reveal_ack',
  EMAIL_ENTERED: 'email_entered',
  CLOSE_CHOICE: 'close_choice',
});

// ---- localhost TCP: sidecar -> main --------------------------------------
const SIDECAR_OUT = Object.freeze({
  HELLO: 'hello',            // { proto, simulate, pid, source: "zone"|"sim" }
  READY: 'ready',            // sidecar finished init, awaiting commands
  LOG: 'log',                // { level, msg }
  ERROR: 'error',            // { code, msg }
  // discovery result during pairing. { devices:[{name,address,rssi,side}] }
  DISCOVERED: 'discovered',
  // raw native metrics (full rate, for diagnostic + engine). MetricsData fields.
  METRICS: 'eeg/metrics',
  // the computed live line frame (downsampled for the wire). EEG_FRAME shape.
  FRAME: 'eeg/frame',
  // band powers + computed beta/(alpha+theta) index (diagnostic cross-check).
  BRAINWAVES: 'eeg/brainwaves',
  // per-bud packet stats from on_stats. { dev1, dev2, elapsed }
  STATS: 'eeg/stats',
  // connection status string from on_connection_status, normalized.
  CONNECTION: 'eeg/connection',
  BATTERY: 'fit/battery',
  IMPEDANCE: 'fit/impedance',
  // engine signals
  PLATEAU: 'session/plateau',   // a real sustained high plateau was detected
  DIP: 'session/dip',           // a real (non-artifact) dip confirmed
  ARCHETYPE: 'session/archetype', // computed features + label at session end
  SESSION_SAMPLES: 'session/samples', // the recorded relative sample array for replay/outputs
});

// ---- localhost TCP: main -> sidecar (commands) ---------------------------
const SIDECAR_IN = Object.freeze({
  PING: 'ping',
  // scan for buds (Zone.discover) without connecting — emits `discovered`
  DISCOVER: 'discover',
  // discover (if needed) + profile-validated connect (real mode). sim ignores addresses.
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  // run battery + impedance fit check, streaming the coaching frames
  START_FIT: 'start_fit',
  STOP_FIT: 'stop_fit',
  // stop impedance, start streaming + the session engine
  START_SESSION: 'start_session',
  STOP_SESSION: 'stop_session',
  // align a guest event onto the EEG timeline (main relays iPad events)
  MARK: 'mark',                // { kind, t }
  // diagnostic: inject the deterministic test signal through the real pipeline
  TEST_SIGNAL: 'test_signal',
  SHUTDOWN: 'shutdown',
});

// ---- the soft live state words (Document.pdf: "settling/focused/dipping/recovering")
const STATE_WORD = Object.freeze({
  SETTLING: 'settling',
  FOCUSED: 'focused',
  DIPPING: 'dipping',
  RECOVERING: 'recovering',
});

// ---- session beats (Document.pdf run-of-show) ----------------------------
const BEAT = Object.freeze({
  IDLE: 'idle',                 // constellation on the TV, no guest
  WELCOME: 'welcome',
  FIT_CHECK: 'fit_check',       // battery + impedance coaching
  INTAKE: 'intake',             // 3 belief questions + on-mind + reading pick
  LIVE: 'live',                 // reading; live line on TV
  INTERRUPTION: 'interruption', // the single fire
  STRONGEST_Q: 'strongest_q',   // brief-pause strongest-stretch question
  REVEAL: 'reveal',             // TV walks the 4 reads; iPad dark standby
  TAKEAWAY: 'takeaway',         // card/profile/email + matched close + dot joins
  CLOSE: 'close',
});

const PROTO_VERSION = 1;

module.exports = {
  PROTO_VERSION,
  SERVER,
  CLIENT,
  GUEST_EVENT,
  SIDECAR_OUT,
  SIDECAR_IN,
  STATE_WORD,
  BEAT,
};
