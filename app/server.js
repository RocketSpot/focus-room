'use strict';
// ============================================================
// server.js — the LAN-facing surface server.
// ------------------------------------------------------------
// One HTTP server (static design surfaces, served locally — never a CDN)
// with a WebSocket upgrade at /ws. The TV window and the guest's iPad both
// connect here. Bound to 0.0.0.0 so the iPad reaches it over the room LAN by
// typing the URL in Safari. This file is pure transport: it broadcasts what
// the orchestrator gives it and emits what clients send back.
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { performance: perf } = require('perf_hooks');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const config = require('./config');

// Loopback forms accepted for the raw-EEG capability in packaged mode (item 3).
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const { CLIENT } = require('./protocol');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

class SurfaceServer extends EventEmitter {
  constructor() {
    super();
    this.http = null;
    this.wss = null;
    this.clients = new Set(); // each ws gets ws.role + ws.id + ws.authorization
    this._nextId = 1;
    this._heartbeat = null;
    // Raw-EEG capability authorization (finding #5). Off until the launcher configures
    // a per-launch token. FAIL-CLOSED: with no token, no socket can ever be authorized.
    this._rawAuth = { token: null, requireLoopback: false };
    this._rawFailWindow = new Map(); // remoteAddr → { count, first } — rate-limit failed attempts
  }

  // The launcher calls this once at startup with an EPHEMERAL, per-launch capability token
  // (256-bit, distinct from the staff token). requireLoopback is true in packaged production.
  configureRawAuth({ token, requireLoopback } = {}) {
    this._rawAuth = { token: (typeof token === 'string' && token) ? token : null, requireLoopback: !!requireLoopback };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.http = http.createServer((req, res) => this._serve(req, res));
      this.wss = new WebSocketServer({ server: this.http, path: '/ws' });
      this.wss.on('connection', (ws, req) => this._onWs(ws, req));
      // room-core retries start() in a loop when the port is squatted — a
      // failed attempt must tear its half-built pair down, or every retry
      // leaks an http server + WebSocketServer with live listeners.
      this.http.on('error', (err) => {
        try { this.wss.close(); } catch (_) {}
        try { this.http.close(); } catch (_) {}
        this.wss = null;
        this.http = null;
        reject(err);
      });
      this.http.listen(config.net.LAN_PORT, '0.0.0.0', () => {
        this._startHeartbeat();
        resolve(this.address());
      });
    });
  }

  // Reap zombie sockets (an iPad that dropped off Wi-Fi never sends a TCP FIN):
  // every sweep, terminate anyone who stayed silent since the last ping, then
  // ping the rest. isAlive flips back via protocol pong or the app-level ping.
  _startHeartbeat() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
      }
    }, 30000);
  }

  // ---- static file serving (sandboxed to webRoot) ----
  _serve(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);

      if (pathname === '/' ) pathname = '/index.html';
      if (pathname === '/__info') return this._info(res);

      // PRIVACY: in dev (and on a web host) webRoot is the repo root, which
      // contains the writable data dir — session records with the guest's
      // typed thoughts and email, plus pending report files. None of that is a
      // surface; never serve it. Dotfiles (.env, .git) are off-limits too.
      const seg = pathname.toLowerCase().split('/').filter(Boolean);
      if (seg[0] === 'data' || seg[0] === 'node_modules' || seg[0] === 'venv'
        || seg.some((s) => s.startsWith('.'))) {
        res.writeHead(403); return res.end('forbidden');
      }

      const root = path.resolve(config.webRoot);
      const filePath = path.resolve(path.join(root, pathname));
      // Path-traversal guard: must stay inside webRoot (robust on Win + macOS).
      const relToRoot = path.relative(root, filePath);
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        res.writeHead(403); return res.end('forbidden');
      }
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) { res.writeHead(404); return res.end('not found'); }
        const ext = path.extname(filePath).toLowerCase();
        const headers = {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        };
        // Renderer containment (finding #5, §4): the TV surfaces host the raw-EEG scope, so
        // they get a restrictive first-party CSP — no remote scripts/objects, no framing, no
        // remote navigation. The app is local-first (no CDN), so 'self' + inline suffices; ws:
        // is allowed for the LAN socket. Other surfaces keep their existing headers.
        if (/^\/tv-[a-z-]+\.html$/.test(pathname)) {
          headers['Content-Security-Policy'] = [
            "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:", "font-src 'self' data:", "media-src 'self' data: blob:",
            "connect-src 'self' ws: wss:", "object-src 'none'", "base-uri 'self'",
            "form-action 'self'", "frame-ancestors 'none'",
          ].join('; ');
          headers['X-Frame-Options'] = 'DENY';
        }
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
      });
    } catch (e) {
      res.writeHead(500); res.end('server error');
    }
  }

  _info(res) {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({
      product: 'Zone Focus Room',
      simulate: config.SIMULATE,
      lanUrls: this.lanUrls(),
      clients: [...this.clients].map((c) => ({ id: c.id, role: c.role })),
    }, null, 2));
  }

  // ---- websocket ----
  _onWs(ws, req) {
    ws.id = this._nextId++;
    ws.role = 'unknown';
    ws.isAlive = true;
    ws.remoteAddress = (req && req.socket && req.socket.remoteAddress) || '';
    // SERVER-OWNED authorization — the ONLY thing raw routing consults. A socket starts
    // unauthenticated and can gain raw-EEG access exactly once (its first hello). A later
    // message can never upgrade it, and a client-declared role never grants raw access.
    ws.authorization = { authenticated: false, role: 'unknown', rawEeg: false, source: null, authenticatedAtMonotonicMs: null };
    ws._helloSeen = false;
    this.clients.add(ws);

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
      if (msg.type === CLIENT.HELLO) {
        const firstHello = !ws._helloSeen;
        ws._helloSeen = true;
        ws.role = String(msg.role || 'unknown');
        // Raw-EEG authorization is decided ONCE, on the first hello, server-side. A second
        // hello can update the display role but can NEVER promote an unauthenticated socket.
        if (firstHello) this._authorizeRaw(ws, msg);
        this.emit('client-hello', { id: ws.id, role: ws.role, rawEeg: ws.authorization.rawEeg, clientTime: msg.clientTime });
        return;
      }
      if (msg.type === CLIENT.PING) {
        ws.isAlive = true;
        try { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); } catch (_) {}
        return;
      }
      // Everything else (guest/intake, guest/event) bubbles to the orchestrator.
      this.emit('client-message', { id: ws.id, role: ws.role, msg });
    });

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => {
      this.clients.delete(ws);
      this.emit('client-left', { id: ws.id, role: ws.role });
    });
    ws.on('error', () => {});

    this.emit('client-joined', { id: ws.id, ip: req.socket.remoteAddress });
  }

  // ---- outbound ----
  // Is anyone with this role currently connected? The orchestrator uses this to
  // distinguish "the guest walked away" from "the Wi-Fi dropped" — they are the
  // same silence, and only one of them should ever end a session.
  hasRole(role) {
    for (const ws of this.clients) if (ws.role === role && ws.readyState === 1) return true;
    return false;
  }

  broadcast(type, payload = {}, role = null) {
    const frame = JSON.stringify({ type, ...payload, t: payload.t ?? Date.now() });
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (role && ws.role !== role) continue;
      try { ws.send(frame); } catch (_) {}
    }
  }

  // ---- raw-EEG capability authorization (finding #5) ----
  // Evaluate a socket's request for the raw-EEG capability at hello time. Grants ONLY when a
  // valid launcher token is presented AND (in packaged mode) the socket is loopback. Fails
  // closed on every other path. Never trusts the client-declared role. Never echoes the token.
  _authorizeRaw(ws, msg) {
    const wants = Array.isArray(msg.capabilities) && msg.capabilities.indexOf('eeg-raw') >= 0;
    if (!wants) return;                                  // socket didn't ask for raw → stays unauthorized
    const supplied = typeof msg.rawStreamToken === 'string' ? msg.rawStreamToken : '';
    if (this._rawTokenMatches(supplied) && this._loopbackOk(ws.remoteAddress)) {
      ws.authorization = {
        authenticated: true, role: ws.role, rawEeg: true, source: 'launcher-token',
        authenticatedAtMonotonicMs: +perf.now().toFixed(1),
      };
    } else {
      this._rawAuthFailure(ws);                          // minimal event + rate-limit; no token, no reason
    }
  }

  // Constant-time token comparison over fixed-length digests (no length leak, never throws).
  // Fails closed when the server has no token configured or the client supplied none.
  _rawTokenMatches(supplied) {
    const expected = this._rawAuth && this._rawAuth.token;
    if (!expected || !supplied) return false;
    const a = crypto.createHash('sha256').update(String(supplied)).digest();
    const b = crypto.createHash('sha256').update(String(expected)).digest();
    return crypto.timingSafeEqual(a, b);
  }

  _loopbackOk(addr) {
    if (!this._rawAuth.requireLoopback) return true;     // dev: token alone (dev is loopback anyway)
    return LOOPBACK_ADDRS.has(String(addr || ''));
  }

  // Minimal local security event on a failed raw-auth attempt — NEVER the supplied token,
  // NEVER a raw sample, NEVER which requirement failed. Rate-limited; closes after repeats.
  _rawAuthFailure(ws) {
    const key = ws.remoteAddress || 'unknown';
    const now = Date.now();
    let w = this._rawFailWindow.get(key);
    if (!w || now - w.first > 60000) { w = { count: 0, first: now }; this._rawFailWindow.set(key, w); }
    w.count += 1;
    if (this._rawFailWindow.size > 1000) this._rawFailWindow.clear();   // bound memory
    this.emit('raw-auth-failure', {
      remoteCategory: LOOPBACK_ADDRS.has(String(ws.remoteAddress || '')) ? 'loopback' : 'remote',
      count: w.count, t: now,
    });
    if (w.count >= 5) { try { ws.close(1008, 'unauthorized'); } catch (_) {} }   // policy violation
  }

  // Broadcast a raw-EEG-gated message ONLY to sockets the SERVER authorized (never by role).
  broadcastRaw(type, payload = {}) {
    const frame = JSON.stringify({ type, ...payload, t: payload.t ?? Date.now() });
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (!ws.authorization || ws.authorization.rawEeg !== true) continue;   // server-owned flag ONLY
      try { ws.send(frame); } catch (_) {}
    }
  }

  // Raw-gated single-client send (late-TV replay of config/quality). No auth → no send.
  sendRawTo(id, type, payload = {}) {
    for (const ws of this.clients) {
      if (ws.id !== id) continue;
      if (!ws.authorization || ws.authorization.rawEeg !== true) return false;
      if (ws.readyState !== ws.OPEN) return false;
      try { ws.send(JSON.stringify({ type, ...payload, t: payload.t ?? Date.now() })); return true; } catch (_) { return false; }
    }
    return false;
  }

  // Send to ONE client by id (the id handed out in client-hello). Replays and
  // re-sends belong to the client that just arrived — broadcasting them to the
  // whole role re-ran animations and re-fired stale chips on everyone else.
  sendTo(id, type, payload = {}) {
    for (const ws of this.clients) {
      if (ws.id !== id) continue;
      if (ws.readyState !== ws.OPEN) return false;
      try { ws.send(JSON.stringify({ type, ...payload, t: payload.t ?? Date.now() })); return true; } catch (_) { return false; }
    }
    return false;
  }

  // Drop one client by id (e.g. a bridge that presented the wrong token).
  closeClient(id) {
    for (const ws of this.clients) {
      if (ws.id === id) { try { ws.close(); } catch (_) { try { ws.terminate(); } catch (_) {} } return true; }
    }
    return false;
  }

  address() {
    const a = this.http.address();
    return { port: a.port, lanUrls: this.lanUrls() };
  }

  // The URL(s) the guest can type on the iPad.
  lanUrls() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          out.push(`http://${ni.address}:${config.net.LAN_PORT}/ipad-flow.html`);
        }
      }
    }
    out.push(`http://localhost:${config.net.LAN_PORT}/ipad-flow.html`);
    return out;
  }

  async stop() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
    if (this.wss) for (const ws of this.clients) { try { ws.terminate(); } catch (_) {} }
    if (this.wss) this.wss.close();
    if (this.http) await new Promise((r) => this.http.close(r));
  }
}

module.exports = { SurfaceServer };
