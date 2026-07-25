'use strict';
// Phase 3 verification driver: a scripted "iPad" guest. Connects as role 'ipad',
// does the sync handshake, then plays the guest action for each beat the
// orchestrator broadcasts — proving the flow advances unattended and the iPad +
// TV stay on the same page. Logs every beat, interruption, and reveal step.
const WebSocket = require('ws');
const port = process.argv[2] || '4321';
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

let offset = 0;
const masterNow = () => Date.now() + offset;
const send = (o) => { try { ws.send(JSON.stringify({ ...o, t: masterNow() })); } catch (_) {} };

let beat = null;
let fitAllGood = false;
let interruptionSeen = false;
const beats = [];
const revealSteps = [];
let acted = {};

function act(b) {
  if (acted[b]) return; // act once per beat entry
  acted[b] = true;
  const A = (fn, ms) => setTimeout(fn, ms);
  switch (b) {
    case 'welcome': A(() => send({ type: 'guest/event', kind: 'earbud_seated' }), 300); break;
    case 'fit':
      // wait for the real fit signal (impedance allGood), then confirm
      (function waitFit() { fitAllGood ? send({ type: 'guest/event', kind: 'fit_confirmed' }) : setTimeout(waitFit, 200); })();
      break;
    case 'intake':
      A(() => send({ type: 'guest/intake', answers: { 0: 'A blip — I barely notice', 1: 'Rock steady, start to finish', 2: 'Almost right away' }, onMind: 'the board deck' }), 400);
      break;
    case 'picker':
      A(() => send({ type: 'guest/intake', reading: { id: 'octopus', title: 'How an Octopus Thinks', meta: '3 min · Science' } }), 400);
      break;
    case 'reading':
      send({ type: 'guest/event', kind: 'reading_started' });
      // keep reading through the dip + recovery (a real guest doesn't stop the
      // instant they're interrupted), then finish — so the recorded session
      // captures the full interruption arc.
      (function waitInt() { interruptionSeen ? setTimeout(() => send({ type: 'guest/event', kind: 'reading_finished' }), 15000) : setTimeout(waitInt, 300); })();
      break;
    case 'strongest':
      A(() => send({ type: 'guest/event', kind: 'strongest_stretch_guess', payload: { choice: 'The turn partway through' } }), 400);
      break;
    case 'standby': break; // orchestrator auto-paces the reveal → email
    case 'email':
      // a non-routable default: against a room with POSTMARK_API_KEY set, every
      // scripted run would otherwise email a real inbox (and burn the send quota)
      A(() => send({ type: 'guest/event', kind: 'email_entered', payload: { email: process.env.FOCUSROOM_FAKE_EMAIL || 'fake-guest@example.com' } }), 400);
      break;
    case 'close':
      A(() => send({ type: 'guest/event', kind: 'close_choice', payload: { door: 'investor' } }), 400);
      break;
  }
}

ws.on('open', () => { send({ type: 'client/hello', role: 'ipad', clientTime: Date.now() }); console.log('› hello (ipad)'); });
ws.on('message', (buf) => {
  let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
  if (m.type === 'reveal/data') {
    console.log(`‹ REVEAL DATA: ${m.archetype && m.archetype.name}${m.flat ? ' (FLAT SESSION)' : ''} · ${(m.reads || []).length} reads · ${(m.samples || []).length} samples`);
    (m.reads || []).forEach((r) => console.log(`    ${r.no} ${r.title} — “${r.v}”${r.ledger ? '  [' + r.ledger.said + ' → ' + r.ledger.did + ']' : ''}`));
  }
  if (m.type === 'session/state' && m.notice) console.log(`‹ NOTICE: ${m.notice}`);
  // The STREAMING signal check has no fit/impedance messages — the clean-read
  // verdict rides canonical session/state (same as the real iPad controller).
  // Listening only for impedance wedged this scripted guest at fit forever.
  if (m.type === 'session/state' && m.fitAllGood === true) fitAllGood = true;
  if (m.type === 'session/sync') { const rtt = Date.now() - m.clientTime; offset = m.serverTime + rtt / 2 - Date.now(); console.log(`‹ sync (offset ${Math.round(offset)}ms)`); }
  else if (m.type === 'fit/impedance') { if (m.allGood) fitAllGood = true; }
  else if (m.type === 'interruption/fire') { interruptionSeen = true; console.log(`‹ INTERRUPTION fire (onMind: "${m.onMind}")`); }
  else if (m.type === 'reveal/step') { revealSteps.push(m.index); console.log(`‹ reveal step ${m.index}: ${m.readText}`); }
  else if (m.type === 'session/state' && m.beat && m.beat !== beat) {
    beat = m.beat; beats.push(beat); console.log(`‹ BEAT → ${beat} (tv: ${m.surface})`);
    if (beat === 'idle' && beats.length > 1) {
      console.log('\n=== guest flow complete ===');
      console.log('beats:', beats.join(' → '));
      console.log('interruption fired:', interruptionSeen, '| reveal steps:', revealSteps.join(','));
      process.exit(0);
    }
    act(beat);
  }
});
ws.on('error', (e) => { console.log('PROBE ERROR', e.message); process.exit(1); });
setTimeout(() => { console.log('\n=== timeout ==='); console.log('beats:', beats.join(' → ')); process.exit(beats.includes('close') ? 0 : 2); }, 90000);
