'use strict';
// Dev-only probe: connect to the LAN WebSocket as a surface client and report
// how many eeg/frame messages arrive — proves the sidecar→main→WS path.
const WebSocket = require('ws');
const port = process.argv[2] || '4321';
const secs = parseFloat(process.argv[3] || '5');
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const counts = {};
let firstFrame = null, lastFrame = null;
ws.on('open', () => ws.send(JSON.stringify({ type: 'client/hello', role: 'probe', t: Date.now() })));
ws.on('message', (b) => {
  let m; try { m = JSON.parse(b.toString()); } catch { return; }
  counts[m.type] = (counts[m.type] || 0) + 1;
  if (m.type === 'eeg/frame') { if (!firstFrame) firstFrame = m; lastFrame = m; }
});
ws.on('error', (e) => { console.log('PROBE ERROR', e.message); process.exit(1); });
setTimeout(() => {
  console.log('message counts:', JSON.stringify(counts));
  if (firstFrame) console.log('first frame:', JSON.stringify(firstFrame));
  if (lastFrame) console.log('last  frame:', JSON.stringify(lastFrame));
  console.log(firstFrame ? 'RESULT: frames flowing ✓' : 'RESULT: no frames ✗');
  process.exit(0);
}, secs * 1000);
