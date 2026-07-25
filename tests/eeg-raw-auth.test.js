'use strict';
// ============================================================
// tests/eeg-raw-auth.test.js — finding #5: raw-EEG WebSocket authorization.
// Integration-level tests against the ACTUAL app/server.js routing path (live ws
// clients) plus method-level tests for the loopback / rotation / rate-limit paths.
// Proves raw eeg/config-v1|raw-v1|quality-v1 reach ONLY a launcher-token-authenticated
// (and, in packaged mode, loopback) socket — never a client-declared role.
//   node tests/eeg-raw-auth.test.js
// ============================================================
process.env.FOCUSROOM_LAN_PORT = process.env.FOCUSROOM_LAN_PORT || '47399';

const path = require('path');
const WebSocket = require('ws');
const { SurfaceServer } = require(path.join(__dirname, '..', 'app', 'server.js'));

let failures = 0;
const check = (n, c, d) => { if (c) console.log('  ok   ' + n); else { failures++; console.error(' FAIL  ' + n + (d !== undefined ? ' — ' + d : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = parseInt(process.env.FOCUSROOM_LAN_PORT, 10);
const TOKEN = 'a1b2'.repeat(16);   // stand-in 256-bit hex token
const isRawType = (t) => /^eeg\/(raw|config|quality)/.test(t || '');

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.rawMsgs = [];
    ws.on('message', (b) => { let m; try { m = JSON.parse(b.toString()); } catch (_) { return; } if (isRawType(m.type)) ws.rawMsgs.push(m); });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const hello = (ws, obj) => ws.send(JSON.stringify(Object.assign({ type: 'client/hello' }, obj)));
const AUTH = { role: 'tv', capabilities: ['eeg-raw'], rawStreamToken: TOKEN };

// method-level mock socket
const mock = (addr) => ({ remoteAddress: addr, role: 'tv', readyState: 1, OPEN: 1,
  authorization: { authenticated: false, role: 'unknown', rawEeg: false, source: null, authenticatedAtMonotonicMs: null },
  close() { this._closed = true; }, send() {} });

(async () => {
  const server = new SurfaceServer();
  server.configureRawAuth({ token: TOKEN, requireLoopback: false });   // loopback tested at method level
  await server.start();

  console.log('\n-- live WebSocket routing --');
  // 1) role tv, NO token → zero raw
  { const ws = await connect(); hello(ws, { role: 'tv' }); await sleep(60);
    server.broadcastRaw('eeg/raw-v1', { samples: [[1]] }); await sleep(60);
    check('role tv with NO token receives zero raw', ws.rawMsgs.length === 0, ws.rawMsgs.length); ws.close(); }

  // 2) role tv, INVALID token → zero raw
  { const ws = await connect(); hello(ws, { role: 'tv', capabilities: ['eeg-raw'], rawStreamToken: 'wrong' }); await sleep(60);
    server.broadcastRaw('eeg/raw-v1', { samples: [[1]] }); await sleep(60);
    check('role tv with an INVALID token receives zero raw', ws.rawMsgs.length === 0, ws.rawMsgs.length); ws.close(); }

  // 3/4) authenticated tv → config + raw + quality
  { const ws = await connect(); hello(ws, AUTH); await sleep(60);
    server.broadcastRaw('eeg/config-v1', { channelLabels: ['Left-A'] });
    server.broadcastRaw('eeg/raw-v1', { samples: [[1]] });
    server.broadcastRaw('eeg/quality-v1', { overallStatus: 'received' }); await sleep(60);
    check('an authenticated local TV receives config + raw + quality', ws.rawMsgs.length === 3, ws.rawMsgs.map((m) => m.type)); ws.close(); }

  // 5/19) no hello / pre-auth → no raw; and no buffered pre-auth delivery
  { const ws = await connect();
    server.broadcastRaw('eeg/raw-v1', { samples: [[9]] }); await sleep(40);   // broadcast while unauthenticated
    check('an unauthenticated socket receives no raw before hello', ws.rawMsgs.length === 0, ws.rawMsgs.length);
    hello(ws, AUTH); await sleep(60);
    check('no pre-auth raw was buffered for later delivery', ws.rawMsgs.length === 0, ws.rawMsgs.length);
    server.broadcastRaw('eeg/raw-v1', { samples: [[9]] }); await sleep(60);
    check('raw flows only AFTER authentication', ws.rawMsgs.length === 1, ws.rawMsgs.length); ws.close(); }

  // 6) role escalation after connection is refused
  { const ws = await connect(); hello(ws, { role: 'tv' }); await sleep(40);
    hello(ws, AUTH); await sleep(40);                                         // a second hello with the token
    server.broadcastRaw('eeg/raw-v1', { samples: [[1]] }); await sleep(60);
    check('a second hello cannot upgrade an unauthenticated socket', ws.rawMsgs.length === 0, ws.rawMsgs.length); ws.close(); }

  // 7/18) a spoofing socket does not inherit an authorized socket's access
  { const a = await connect(); const b = await connect();
    hello(a, AUTH); hello(b, { role: 'tv' }); await sleep(60);
    server.broadcastRaw('eeg/raw-v1', { samples: [[1]] }); await sleep(60);
    check('the authorized socket receives raw', a.rawMsgs.length === 1, a.rawMsgs.length);
    check('a same-role spoofing socket does NOT inherit access', b.rawMsgs.length === 0, b.rawMsgs.length);
    a.close(); b.close(); }

  // 10/11/12) iPad, reveal, generic browser roles → zero raw
  for (const role of ['ipad', 'reveal', 'browser', 'ops', 'audio']) {
    const ws = await connect(); hello(ws, { role }); await sleep(50);
    server.broadcastRaw('eeg/config-v1', {}); server.broadcastRaw('eeg/raw-v1', { samples: [[1]] }); server.broadcastRaw('eeg/quality-v1', {}); await sleep(50);
    check(`role '${role}' receives zero raw/config/quality`, ws.rawMsgs.length === 0, ws.rawMsgs.length); ws.close();
  }

  // 15) validation mode must not bypass the gate
  { process.env.FOCUSROOM_VALIDATION = '1';
    const ws = await connect(); hello(ws, { role: 'tv' }); await sleep(50);
    server.broadcastRaw('eeg/raw-v1', { samples: [[1]] }); await sleep(50);
    check('validation mode does NOT bypass auth (no-token tv still gets zero)', ws.rawMsgs.length === 0, ws.rawMsgs.length);
    delete process.env.FOCUSROOM_VALIDATION; ws.close(); }

  // 16/17) disconnect clears authorization; reconnect requires reauth
  { const ws = await connect(); hello(ws, AUTH); await sleep(50); ws.close(); await sleep(60);
    const ws2 = await connect(); hello(ws2, { role: 'tv' }); await sleep(50);   // reconnect WITHOUT token
    server.broadcastRaw('eeg/raw-v1', { samples: [[1]] }); await sleep(60);
    check('a reconnected socket must re-authenticate (no inherited auth)', ws2.rawMsgs.length === 0, ws2.rawMsgs.length); ws2.close(); }

  await server.stop();

  console.log('\n-- method-level (loopback / rotation / rate-limit / fail-closed) --');
  // 3) non-loopback rejected in packaged mode; loopback forms accepted
  { const s = new SurfaceServer(); s.configureRawAuth({ token: TOKEN, requireLoopback: true });
    const remote = mock('192.168.1.50'); s._authorizeRaw(remote, AUTH);
    check('packaged mode: non-loopback + valid token is NOT authorized', remote.authorization.rawEeg === false);
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const m = mock(a); s._authorizeRaw(m, AUTH);
      check(`packaged mode: loopback ${a} + valid token IS authorized`, m.authorization.rawEeg === true);
    }
  }

  // 8) a token from a previous launcher process is rejected after rotation
  { const s = new SurfaceServer(); s.configureRawAuth({ token: 'OLD', requireLoopback: false });
    check('the old token matches before rotation', s._rawTokenMatches('OLD'));
    s.configureRawAuth({ token: 'NEW', requireLoopback: false });               // launcher restart → new token
    check('a previous-launcher token is rejected after rotation', s._rawTokenMatches('OLD') === false && s._rawTokenMatches('NEW') === true); }

  // 9) fail-closed when the server has no token configured
  { const s = new SurfaceServer();                                             // never configured
    check('fail-closed: no server token → any supplied token rejected', s._rawTokenMatches(TOKEN) === false);
    s.configureRawAuth({ token: null, requireLoopback: false });
    check('fail-closed: explicit null token → rejected', s._rawTokenMatches('anything') === false);
    const m = mock('127.0.0.1'); s._authorizeRaw(m, AUTH);
    check('fail-closed: authorize with no server token → not authorized', m.authorization.rawEeg === false); }

  // 13/14) an invalid-token attempt logs neither the token nor raw samples
  { const s = new SurfaceServer(); s.configureRawAuth({ token: TOKEN, requireLoopback: false });
    let evt = null; s.on('raw-auth-failure', (e) => { evt = e; });
    s._authorizeRaw(mock('127.0.0.1'), { role: 'tv', capabilities: ['eeg-raw'], rawStreamToken: 'secretguess-9f' });
    check('a failed attempt emits a minimal security event', !!evt);
    check('the event contains NO supplied token', evt && JSON.stringify(evt).indexOf('secretguess') < 0 && !('token' in evt) && !('rawStreamToken' in evt), JSON.stringify(evt));
    check('the event contains no raw samples', evt && !('samples' in evt)); }

  // 20) repeated invalid attempts are rate-limited (socket closed) with bounded state
  { const s = new SurfaceServer(); s.configureRawAuth({ token: TOKEN, requireLoopback: false });
    const rl = mock('10.0.0.9');
    for (let i = 0; i < 5; i++) s._authorizeRaw(rl, { role: 'tv', capabilities: ['eeg-raw'], rawStreamToken: 'bad' });
    check('repeated invalid attempts close the socket (policy violation)', rl._closed === true);
    check('the failure rate-limit state stays bounded', s._rawFailWindow.size <= 1000); }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
