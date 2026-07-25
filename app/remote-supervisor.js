'use strict';
// ============================================================
// RemoteSupervisor — the room's signal engine when the earbuds live on a
// DIFFERENT machine than the room brain (web deployment + real hardware).
// ------------------------------------------------------------
// The desktop runs bridge/desktop-bridge.js: the REAL sidecar (Zone SDK,
// Bluetooth) spawned locally, its NDJSON stream forwarded up to the room
// over the same WebSocket the surfaces use, as role 'bridge'. This class
// presents the exact SidecarSupervisor interface (events: ready / message /
// stderr / exit / restarting / connected / disconnected; info; start/stop/
// send), so room-core cannot tell the difference.
//
// HONESTY: the mode badge derives from the BRIDGE'S OWN sidecar hello
// (simulate true/false) — the room never assumes. And the bridge must
// present the shared token; without it, its messages are ignored loudly.
// A missing bridge is a PAUSE (the stall detector already treats a quiet
// stream as one) — never a silent fallback to simulation.
// ============================================================
const { EventEmitter } = require('events');

class RemoteSupervisor extends EventEmitter {
  constructor(server, token) {
    super();
    if (!token) throw new Error('bridge mode requires FOCUSROOM_BRIDGE_TOKEN (refusing to accept unauthenticated signal)');
    this.server = server;
    this.token = token;
    this.bridgeId = null;        // the authenticated bridge client id
    this.ready = false;
    this.lastHello = null;       // the DESKTOP sidecar's hello (carries simulate)

    server.on('client-message', ({ id, role, msg }) => {
      if (role !== 'bridge' || !msg) return;
      if (msg.type === 'bridge/hello') {
        if (msg.token !== this.token) {
          console.error('[bridge] REJECTED a bridge with a wrong token — closing its socket');
          if (this.server.closeClient) this.server.closeClient(id);
          return;
        }
        this.bridgeId = id;
        // The desktop sidecar usually booted before the link opened — its mode
        // (sim vs real buds) rides EVERY bridge hello. Always take the fresh
        // value: freezing the first one meant a bridge restarted in the other
        // mode (sim ↔ real) kept the stale badge — a wrong REAL EEG label.
        if (msg.info) {
          this.lastHello = { simulate: !!msg.info.simulate, source: msg.info.source || null };
        }
        console.log('[bridge] desktop bridge connected');
        // accepted goes to THIS bridge — role-broadcasting leaked it (and every
        // bridge/cmd) to any WS client merely claiming role 'bridge'
        if (this.server.sendTo) this.server.sendTo(id, 'bridge/accepted', {});
        else this.server.broadcast('bridge/accepted', {}, 'bridge');
        this.emit('connected');
        return;
      }
      if (msg.type === 'bridge/out' && id === this.bridgeId && msg.msg) {
        const m = msg.msg;
        if (m.type === 'hello') this.lastHello = m;
        if (m.type === 'ready') { this.ready = true; this.emit('ready', m); }
        this.emit('message', m);
      }
    });
    server.on('client-left', ({ id, role }) => {
      if (role === 'bridge' && id === this.bridgeId) {
        this.bridgeId = null;
        this.ready = false;
        console.log('[bridge] desktop bridge dropped — the stream pauses until it returns');
        this.emit('disconnected');
        this.emit('exit', { code: null, signal: 'bridge-dropped' });
      }
    });
  }

  get info() {
    return {
      remote: true,
      running: this.bridgeId != null,
      ready: this.ready,
      simulate: this.lastHello ? !!this.lastHello.simulate : null,
      source: this.lastHello ? this.lastHello.source : null,
    };
  }

  async start() { console.log('[bridge] waiting for the desktop bridge to dial in…'); }
  async stop() {}

  send(type, payload = {}) {
    if (this.bridgeId == null) return false;
    try {
      // target the AUTHENTICATED bridge only — a role broadcast handed the
      // room's command stream to any client that merely claimed role 'bridge'
      if (this.server.sendTo) return this.server.sendTo(this.bridgeId, 'bridge/cmd', { cmd: type, payload });
      this.server.broadcast('bridge/cmd', { cmd: type, payload }, 'bridge');
      return true;
    } catch (e) { return false; }
  }
}

module.exports = { RemoteSupervisor };
