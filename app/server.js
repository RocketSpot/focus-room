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
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const config = require('./config');
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
    this.clients = new Set(); // each ws gets ws.role + ws.id
    this._nextId = 1;
    this._heartbeat = null;
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
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
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
    this.clients.add(ws);

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
      if (msg.type === CLIENT.HELLO) {
        ws.role = String(msg.role || 'unknown');
        this.emit('client-hello', { id: ws.id, role: ws.role, clientTime: msg.clientTime });
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
