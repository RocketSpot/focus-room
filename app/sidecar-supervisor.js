'use strict';
// ============================================================
// sidecar-supervisor.js, spawn + supervise the Python sidecar.
// ------------------------------------------------------------
// Electron main owns a localhost-only TCP server. It spawns the sidecar
// (frozen binary in prod, venv python in dev) and hands it the port; the
// sidecar connects back and the two exchange newline-delimited JSON
// (NDJSON). If the sidecar process dies or the link drops unexpectedly, the
// supervisor restarts it with capped backoff. The guest never sees Python,
// a terminal, or a gap.
// ============================================================
const net = require('net');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const config = require('./config');
const { SIDECAR_IN } = require('./protocol');

const RESTART_BACKOFF_MS = [400, 800, 1500, 3000, 5000];
const STDERR_RING = 200; // keep last N sidecar stderr lines for the diagnostic view

class SidecarSupervisor extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.socket = null;
    this.child = null;
    this.port = null;
    this._buf = '';
    this._stopping = false;
    this._restarts = 0;
    this._ready = false;
    this._stderr = [];
  }

  get ready() {
    return this._ready;
  }

  get info() {
    return {
      running: !!this.child && this.child.exitCode === null,
      connected: !!this.socket && !this.socket.destroyed,
      ready: this._ready,
      restarts: this._restarts,
      pid: this.child ? this.child.pid : null,
      simulate: config.SIMULATE,
      frozen: config.sidecar.frozen,
      port: this.port,
    };
  }

  async start() {
    this._stopping = false;
    await this._listen();
    this._spawn();
  }

  _listen() {
    return new Promise((resolve, reject) => {
      if (this.server) return resolve();
      let listening = false;
      this.server = net.createServer((socket) => this._onConnection(socket));
      // 'fault', never 'error': an unlistened EventEmitter 'error' THROWS, so a
      // stray TCP error would become an uncaughtException → crash-guard relaunch
      // → loop breaker leaving the room dark, instead of a logged fault.
      this.server.on('error', (err) => {
        if (!listening) { this.server = null; return reject(err); }
        this._log('error', `sidecar control server error: ${err.message}`);
        this.emit('fault', err);
      });
      // Ephemeral port on loopback only, never exposed off-box.
      const wantPort = config.net.SIDECAR_PORT || 0;
      this.server.listen(wantPort, config.net.SIDECAR_HOST, () => {
        listening = true;
        this.port = this.server.address().port;
        resolve();
      });
    });
  }

  _spawn() {
    const { command, baseArgs } = config.sidecar;
    const args = [
      ...baseArgs,
      '--host', config.net.SIDECAR_HOST,
      '--port', String(this.port),
    ];
    if (config.SIMULATE) args.push('--simulate');

    this._log('info', `spawning sidecar: ${command} ${args.join(' ')}`);
    this._ready = false;

    this.child = spawn(command, args, {
      cwd: config.sidecar.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' },
    });

    this.child.on('error', (err) => {
      this._log('error', `sidecar spawn error: ${err.message}`);
      // 'fault', never 'error': with no listener registered, emitting 'error'
      // THREW out of this handler, the restart below never ran, and the crash
      // guard relaunched the whole app into the same spawn error until the
      // loop breaker kept the room down. A missing interpreter must degrade to
      // the capped-backoff retry ladder, not an outage.
      this.emit('fault', err);
      // ENOENT/EACCES fire 'error' but not 'exit', recover here too.
      if (!this._stopping) this._scheduleRestart();
    });

    const onLine = (stream) => (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => {
          this._stderr.push(line);
          if (this._stderr.length > STDERR_RING) this._stderr.shift();
          this.emit('stderr', line);
          if (config.isDev) process.stdout.write(`[sidecar:${stream}] ${line}\n`);
        });
    };
    this.child.stdout.on('data', onLine('out'));
    this.child.stderr.on('data', onLine('err'));

    this.child.on('exit', (code, signal) => {
      this._ready = false;
      this._log('warn', `sidecar exited code=${code} signal=${signal}`);
      this.emit('exit', { code, signal });
      if (!this._stopping) this._scheduleRestart();
    });
  }

  _onConnection(socket) {
    // Only one sidecar at a time; drop any stale socket.
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = socket;
    this._buf = '';
    socket.setNoDelay(true);
    socket.setEncoding('utf8');

    socket.on('data', (data) => this._onData(data));
    socket.on('close', () => {
      // A STALE socket closing (we just replaced it with a fresh connection)
      // must not clear readiness or report a disconnect for the live link.
      if (this.socket !== socket) return;
      this.socket = null;
      this._ready = false;
      this.emit('disconnected');
      // The header promises a restart when "the link drops unexpectedly", but a
      // hung sidecar can close its socket while the process survives, which used
      // to leave the room signal-dead forever (send() false, no backoff, nothing
      // on the ops console able to revive it). Give the sidecar a grace window
      // to dial back in; if it doesn't, kill it so the exit handler runs the
      // normal restart ladder.
      if (!this._stopping && this.child && this.child.exitCode === null) {
        if (this._reconnectGrace) clearTimeout(this._reconnectGrace);
        this._reconnectGrace = setTimeout(() => {
          this._reconnectGrace = null;
          if (this._stopping || this.socket) return; // reconnected or shutting down
          if (this.child && this.child.exitCode === null) {
            this._log('warn', 'sidecar link closed and never redialed, restarting the process');
            try { this.child.kill(); } catch (_) {}
          }
        }, 6000);
      }
    });
    socket.on('error', (err) => this._log('warn', `sidecar socket error: ${err.message}`));

    if (this._reconnectGrace) { clearTimeout(this._reconnectGrace); this._reconnectGrace = null; }
    this.emit('connected');
  }

  _onData(data) {
    this._buf += data;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        this._log('warn', `bad sidecar JSON: ${line.slice(0, 120)}`);
        continue;
      }
      if (msg.type === 'ready') {
        this._ready = true;
        this._restarts = 0; // a clean ready resets the backoff ladder
        this.emit('ready', msg);
      }
      this.emit('message', msg);
    }
  }

  // Send a command to the sidecar. Returns false if the link is down.
  send(type, payload = {}) {
    if (!this.socket || this.socket.destroyed) return false;
    // payload.t wins: the MARK command carries the guest event's master-clock
    // timestamp, and re-stamping it with the send time shifted every relayed
    // mark by the relay/queue delay on the recorded timeline. (server.js's
    // broadcast() already honors payload.t the same way.)
    const msg = JSON.stringify({ t: Date.now(), ...payload, type }) + '\n';
    this.socket.write(msg);
    return true;
  }

  _scheduleRestart() {
    if (this._restartPending) return; // 'error' and 'exit' can both fire once
    this._restartPending = true;
    const delay =
      RESTART_BACKOFF_MS[Math.min(this._restarts, RESTART_BACKOFF_MS.length - 1)];
    this._restarts += 1;
    this._log('info', `restarting sidecar in ${delay}ms (attempt ${this._restarts})`);
    this.emit('restarting', { attempt: this._restarts, delay });
    setTimeout(() => {
      this._restartPending = false;
      if (!this._stopping) this._spawn();
    }, delay);
  }

  async stop() {
    this._stopping = true;
    if (this._reconnectGrace) { clearTimeout(this._reconnectGrace); this._reconnectGrace = null; }
    try {
      this.send(SIDECAR_IN.SHUTDOWN);
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
    if (this.child && this.child.exitCode === null) {
      try { this.child.kill(); } catch (_) {}
    }
    if (this.socket) { try { this.socket.destroy(); } catch (_) {} }
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; }
  }

  recentStderr() {
    return this._stderr.slice();
  }

  _log(level, msg) {
    this.emit('log', { level, msg });
    if (config.isDev) process.stdout.write(`[supervisor] ${msg}\n`);
  }
}

module.exports = { SidecarSupervisor };
