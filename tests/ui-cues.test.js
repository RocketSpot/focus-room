'use strict';
// ui/cue gating: cues fire for exactly the accepted begin/end taps, never mid-session.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Orchestrator } = require(path.join(ROOT, 'app', 'orchestrator.js'));

let fail = 0;
const ok = (n, c, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${n}${c ? '' : ' — ' + d}`); if (!c) fail++; };

let cues = 0;
const beats = [];
const supervisor = { send: () => true };
const server = { broadcast: (type, payload) => {
  if (type === 'ui/cue') cues++;
  if (type === 'session/state') beats.push(payload.beat);
} };
const orch = new Orchestrator({ supervisor, server, log: () => {} });

const ev = (kind, payload) => orch.onClientMessage({ type: 'guest/event', kind, payload: payload || {}, t: Date.now() }, 'ipad');
const intake = (f) => orch.onClientMessage(Object.assign({ type: 'guest/intake', t: Date.now() }, f), 'ipad');
const cueDelta = (fn) => { const before = cues; fn(); return cues - before; };

const d0 = cueDelta(() => orch.onClientHello({ role: 'ipad', clientTime: Date.now() }));
ok('hello produces no cue', d0 === 0, 'got ' + d0);

ok('earbud_seated @welcome → 1 cue', cueDelta(() => ev('earbud_seated')) === 1 && orch.beat === 'fit');
ok('stray reading_started @fit → 0 cues (unaccepted input)', cueDelta(() => ev('reading_started')) === 0);
ok('fit_confirmed @fit → 1 cue', cueDelta(() => ev('fit_confirmed')) === 1 && orch.beat === 'intake');
ok('intake submit @intake → 1 cue', cueDelta(() => intake({ answers: { 0: 'A blip' }, onMind: 'deadline' })) === 1 && orch.beat === 'picker');
ok('double intake (no reading) @picker → 0 cues', cueDelta(() => intake({ answers: { 0: 'again' } })) === 0 && orch.beat === 'picker');
ok('reading pick @picker → 1 cue', cueDelta(() => intake({ reading: { id: 'octopus', title: 'How an Octopus Thinks' } })) === 1 && orch.beat === 'reading');

ok('reading_started @reading → 0 cues', cueDelta(() => ev('reading_started')) === 0);
ok('reading_finished @reading → 0 cues (ends the session silently)', cueDelta(() => ev('reading_finished')) === 0 && orch.beat === 'strongest');
ok('strongest guess @strongest → 0 cues', cueDelta(() => ev('strongest_stretch_guess', { choice: 'The ending' })) === 0 && orch.beat === 'standby');

ok('reveal_ack @standby → 1 cue', cueDelta(() => ev('reveal_ack')) === 1 && orch.beat === 'email');
ok('email_entered @email → 1 cue', cueDelta(() => ev('email_entered', { email: 'g@x.com' })) === 1 && orch.beat === 'close');
ok('close_choice @close → 1 cue', cueDelta(() => ev('close_choice', { door: 'customer' })) === 1 && orch.beat === 'idle');

// The iPad's socket stays open between guests, so the next guest never re-sends
// client/hello. Their first tap at idle must START a session (it used to be
// dropped, wedging the room until someone reloaded the page) — and it's an
// accepted beginning-beat tap, so it cues.
ok('tap @idle starts a fresh session', cueDelta(() => ev('earbud_seated')) === 1 && orch.beat === 'fit',
  `beat=${orch.beat}`);
ok('the fresh session is clean', orch.answers.email == null && orch.answers.strongest == null,
  JSON.stringify({ email: orch.answers.email, strongest: orch.answers.strongest }));

console.log(`\n${fail === 0 ? 'ALL GREEN' : fail + ' FAILURE(S)'}`);
process.exit(fail === 0 ? 0 : 1);
