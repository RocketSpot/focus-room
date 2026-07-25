'use strict';
// Dev harness: stand in for Electron main's localhost TCP link and drive the
// sidecar directly. Lets us exercise the REAL Zone SDK path (discover/connect)
// and the sim path without launching Electron.
//   node build/sidecar-harness.js --cmds discover --seconds 12         (real)
//   node build/sidecar-harness.js --simulate --cmds start_session -s 5 (sim)
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const simulate = argv.includes('--simulate');
const getOpt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const cmds = (getOpt('--cmds', '') || '').split(',').filter(Boolean);
const seconds = parseFloat(getOpt('--seconds', getOpt('-s', '12')));

const seen = {};
const server = net.createServer((sock) => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      seen[m.type] = (seen[m.type] || 0) + 1;
      if (['hello', 'ready', 'discovered', 'error', 'fit/battery', 'fit/impedance', 'eeg/connection'].includes(m.type))
        console.log('<', JSON.stringify(m));
      if (m.type === 'ready') {
        let delay = 300;
        for (const c of cmds) {
          const cc = c;
          setTimeout(() => { console.log('>', cc); sock.write(JSON.stringify({ type: cc, t: Date.now() }) + '\n'); }, delay);
          delay += 300;
        }
      }
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const py = path.join(root, 'venv', 'Scripts', 'python.exe');
  const args = [path.join(root, 'sidecar', 'main.py'), '--host', '127.0.0.1', '--port', String(port)];
  if (simulate) args.push('--simulate');
  const child = spawn(py, args, { cwd: root, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' } });
  child.stderr.on('data', (d) => process.stderr.write('[err] ' + d));
  child.on('exit', (code) => console.log('sidecar exit', code));
  setTimeout(() => {
    console.log('--- summary:', JSON.stringify(seen));
    try { child.kill(); } catch {}
    server.close();
    process.exit(0);
  }, seconds * 1000);
});
