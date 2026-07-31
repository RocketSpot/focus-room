'use strict';
// ============================================================
// tests/eeg-eligibility.test.js — Phase 2A.2 correction 1: the eligibility state
// machine, at the orchestrator. Proves:
//   • packet receipt alone (transportReady) cannot make the room ready to advance;
//   • analysisEligible IS what unlocks the ready state;
//   • a staff override allows navigation but disables EEG-derived reveal results and
//     never labels the session "measured";
//   • revealEligible gates guest claims independently of analysisEligible (real mode);
//   • simulation is exempt from the revealEligible gate (a demonstration of output).
// Plain node, no framework:  node tests/eeg-eligibility.test.js
// ============================================================
process.env.FOCUSROOM_PROCESS_MS = '0';               // reveal computes synchronously
process.env.FOCUSROOM_PLATEAU_FALLBACK_MS = '600000'; // never auto-fire during the test
process.env.FOCUSROOM_REVEAL_STEP_MS = '600000';

const path = require('path');
const { Orchestrator } = require(path.join(__dirname, '..', 'app', 'orchestrator.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(` FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`); }
}

function makeOrch() {
  const sent = [], states = [];
  const supervisor = { send: (type, payload) => { sent.push({ type, payload }); return true; } };
  const server = { broadcast: (type, payload) => { if (type === 'session/state') states.push(payload); } };
  const orch = new Orchestrator({ supervisor, server, log: () => {} });
  return { orch, sent, states };
}

let _tRel = 0;
const frame = (orch, sq) => orch.onSidecar({ type: 'eeg/frame', tRel: (_tRel += 1), t: Date.now(), engagementRel: 0.5, signalQuality: sq, stateWord: 'focused' });
const quality = (orch, elig, sim) => orch.onSidecar({ type: 'eeg/quality-v1', overallStatus: elig.analysisEligible ? 'received' : 'limited', eligibility: elig, simulation: sim });
const ev = (orch, kind, payload) => orch.onClientMessage({ type: 'guest/event', kind, payload, t: Date.now() }, 'ipad');
const intake = (orch, fields) => orch.onClientMessage(Object.assign({ type: 'guest/intake', t: Date.now() }, fields), 'ipad');

// build an eligibility object with sane defaults; override what a test cares about
const ELIG = (o) => Object.assign({
  transportReady: true, displayEligible: true, analysisEligible: false, revealEligible: false,
  eligibilityStatus: 'checking', qualityThresholdStatus: 'provisional', staffOverride: false, reasons: [],
  ears: { left: { selected: null, usable: false }, right: { selected: null, usable: false } },
}, o || {});
const BOTH_EARS = { ears: { left: { selected: 'Left-A', usable: true }, right: { selected: 'Right-A', usable: true } } };

function toFit(orch) {
  orch.onClientHello({ role: 'ipad', clientTime: Date.now() });   // idle → welcome
  ev(orch, 'earbud_seated');                                      // welcome → fit
}
function toReading(orch) {
  ev(orch, 'fit_confirmed');                                      // fit → intake
  intake(orch, { answers: { 0: 'x' }, onMind: 'demo' });          // intake → picker
  intake(orch, { reading: { id: 'octopus', title: 'How an Octopus Thinks' } }); // picker → reading
}
function toReveal(orch) {
  ev(orch, 'reading_finished');                                   // reading → strongest
  ev(orch, 'strongest_stretch_guess', { choice: 'The ending' });  // strongest → standby (reveal computed)
}

// ---- 1) the room is NEVER gated or held by signal quality ----
// The guest experience must not depend on the signal being good, and the room must
// never narrate the signal. Eligibility is still COMPUTED (it gates EEG-derived
// CLAIMS further down, and it is the validation evidence) — it just never blocks.
console.log('\n-- the room is never gated by signal quality --');
{
  const { orch } = makeOrch();
  toFit(orch);
  quality(orch, ELIG({ transportReady: true, analysisEligible: false }), false);   // a POOR signal
  for (let i = 0; i < 5; i++) frame(orch, 1.0);
  check('a poor / analysis-ineligible signal still lets the room become ready', orch._fitAllGood === true, `fitAllGood=${orch._fitAllGood}`);
  check('eligibility is still computed and kept for engineering', !!orch._eegEligibility && orch._eegEligibility.analysisEligible === false);
  check('session/state still carries the eligibility summary', !!orch._signalEligibilitySummary());
  check('NO guest-facing signal notice is ever produced', orch._notice() === null);
}
// even with NO quality stream at all, the settle alone opens the room
{
  const { orch } = makeOrch();
  toFit(orch);
  for (let i = 0; i < 3; i++) frame(orch, 0.05);   // terrible frame quality, no eeg/quality-v1
  check('a terrible signal with no quality stream still opens the room', orch._fitAllGood === true, `fitAllGood=${orch._fitAllGood}`);
}

// ---- 2) staff override: navigation allowed, EEG-derived reveal disabled ----
console.log('\n-- staff / demonstration override --');
{
  const { orch, states } = makeOrch();
  toFit(orch);
  const ov = orch.setStaffOverride(true, 'demo');
  check('staff override enables', ov === true && orch._staffOverride === true);
  check('staff override is visible on session/state', states[states.length - 1] && states[states.length - 1].staffOverride === true);
  quality(orch, ELIG({ analysisEligible: false }), false);        // signal NOT usable
  for (let i = 0; i < 3; i++) frame(orch, 1.0);
  check('override lets the fit become ready despite unusable signal', orch._fitAllGood === true, `fitAllGood=${orch._fitAllGood}`);
  toReading(orch);
  check('reached reading under staff override', orch.beat === 'reading', orch.beat);
  toReveal(orch);
  check('reached the reveal (navigation allowed)', orch.beat === 'standby', orch.beat);
  const r = orch.reveal;
  check('reveal: EEG-derived claims disabled', r.eegDerivedClaimsAllowed === false);
  check('reveal: marked invalid-for-eeg-interpretation', r.dataQualityStatus === 'invalid-for-eeg-interpretation', r.dataQualityStatus);
  check('reveal: no measured stats', r.stats === null);
  check('reveal: archetype not labelled measured', r.archetype && r.archetype.measured === false, JSON.stringify(r.archetype));
  check('reveal: no read carries a numeric stat', (r.reads || []).every((rd) => rd.stat == null));
  const rec = orch._sessionRecord();
  check('record: staffOverride true + invalid-for-eeg-interpretation', rec.staffOverride === true && rec.dataQualityStatus === 'invalid-for-eeg-interpretation');
  check('record: eegDerivedClaimsAllowed false', rec.eegDerivedClaimsAllowed === false);
  // clearing the override restores the analysis-eligibility requirement
  orch.setStaffOverride(false);
  check('clearing override drops _fitQualityOk back to signal truth', orch._fitQualityOk === false);
}

// ---- 3) revealEligible gates claims independently of analysisEligible (REAL mode) ----
console.log('\n-- revealEligible is separate from analysisEligible (real) --');
{
  const { orch } = makeOrch();
  toFit(orch);
  quality(orch, ELIG(Object.assign({ analysisEligible: true, revealEligible: false, eligibilityStatus: 'provisional-pass' }, BOTH_EARS)), false);
  for (let i = 0; i < 3; i++) frame(orch, 1.0);
  check('analysisEligible advances the fit even when revealEligible is false', orch._fitAllGood === true);
  toReading(orch);
  quality(orch, ELIG(Object.assign({ analysisEligible: true, revealEligible: false }, BOTH_EARS)), false);
  toReveal(orch);
  check('real + revealEligible:false → EEG claims suppressed', orch.reveal.eegDerivedClaimsAllowed === false);
  check('real + revealEligible:false → insufficient-usable-data', orch.reveal.dataQualityStatus === 'insufficient-usable-data', orch.reveal.dataQualityStatus);
}

// ---- 4) simulation is exempt from the revealEligible gate ----
console.log('\n-- simulation is exempt from the revealEligible gate --');
{
  const { orch } = makeOrch();
  toFit(orch);
  quality(orch, ELIG(Object.assign({ analysisEligible: true, revealEligible: false }, BOTH_EARS)), true);  // sim
  for (let i = 0; i < 3; i++) frame(orch, 1.0);
  toReading(orch);
  quality(orch, ELIG(Object.assign({ analysisEligible: true, revealEligible: false }, BOTH_EARS)), true);
  toReveal(orch);
  check('sim: revealEligible:false does NOT suppress the demo reveal', orch.reveal.eegDerivedClaimsAllowed === true, orch.reveal.dataQualityStatus);
  check('sim: dataQualityStatus ok', orch.reveal.dataQualityStatus === 'ok', orch.reveal.dataQualityStatus);
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
