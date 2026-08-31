'use strict';
// ============================================================
// Session event integrity regressions.
//
// Proves that one rendered notification becomes one timeline event, events
// outside the reading never receive a fabricated/negative reading coordinate,
// and a no-claim reveal cannot create a named constellation archetype.
// Plain node: node tests/session-event-integrity.test.js
// ============================================================
process.env.FOCUSROOM_REVEAL_STEP_MS = '600000';

const path = require('path');
const { Orchestrator } = require(path.join(__dirname, '..', 'app', 'orchestrator.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.error(` FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function makeOrch() {
  return new Orchestrator({
    supervisor: { send: () => true },
    server: { broadcast: () => {} },
    log: () => {},
  });
}

console.log('\n-- notification event is recorded once --');
{
  const orch = makeOrch();
  const base = 1_000_000;
  orch.beat = 'reading';
  orch.sessionStartedAt = base;
  orch.timeline = { streamEpoch: base, lastFrame: { tRel: 2, t: base + 2000 } };
  orch.interruptionTiming = {
    eventRenderedTime: null,
    eventRenderedEegT: null,
    timingMethod: 'app_fire_call',
    timingUncertaintyMs: 1200,
    timingConfidence: 'low',
    visual: {
      renderedFrameMonotonicMs: null,
      renderReportReceivedMonotonicMs: null,
      timingConfidence: 'low',
    },
  };
  orch._record('interruption_fired', base + 4000);

  const report = {
    type: 'guest/event',
    kind: 'notification_shown',
    t: base + 5010,
    payload: { shownAt: base + 5000, renderedMonotonicMs: 123.4 },
  };
  orch.onClientMessage(report, 'ipad');
  orch.onClientMessage(report, 'ipad'); // transport retry / duplicate report

  const fired = orch.events.filter((event) => event.kind === 'interruption_fired');
  const shown = orch.events.filter((event) => event.kind === 'notification_shown');
  check('fire and committed paint remain separate event kinds', fired.length === 1 && shown.length === 1,
    JSON.stringify(orch.events.map((event) => event.kind)));
  check('notification uses the committed-paint wall timestamp', shown[0] && shown[0].masterT === base + 5000,
    shown[0] && shown[0].masterT);
  check('notification render payload is retained on the single event',
    shown[0] && shown[0].payload.renderedMonotonicMs === 123.4);
  check('timing schema and event share the same reading coordinate',
    orch.interruptionTiming.eventRenderedEegT === 5 && shown[0] && shown[0].eegT === 5);
}

console.log('\n-- EEG-relative event coordinates belong only to the reading --');
{
  const orch = makeOrch();
  orch.timeline = { streamEpoch: 10_000, lastFrame: { tRel: 2, t: 12_000 } };
  orch._record('baseline_start', 11_000);
  check('signal-check/pre-reading event keeps wall time but has eegT null',
    orch.events[0].masterT === 11_000 && orch.events[0].eegT === null,
    JSON.stringify(orch.events[0]));

  orch.sessionStartedAt = 20_000;
  orch.timeline = { streamEpoch: 21_000, lastFrame: { tRel: 0, t: 21_000 } };
  orch._record('reading_started', 20_500); // synced client stamp precedes first EEG epoch
  orch._record('reading_progress_marker', 21_750);
  check('a pre-anchor client timestamp never becomes a negative eegT',
    orch.events[1].eegT === null, JSON.stringify(orch.events[1]));
  check('a valid in-reading event retains its measured coordinate',
    orch.events[2].eegT === 0.75, JSON.stringify(orch.events[2]));
  check('no event timeline entry contains a negative EEG coordinate',
    orch.events.every((event) => event.eegT == null || event.eegT >= 0), JSON.stringify(orch.events));
}

console.log('\n-- no measurement means no named constellation position --');
{
  const orch = makeOrch();
  const joins = [];
  orch.on('dot-join', (payload) => joins.push(payload));
  orch.beat = 'standby';
  orch.answers.archetype = 'deep'; // fallback label that used to leak into the wall
  orch.reveal = {
    eegDerivedClaimsAllowed: false,
    archetype: { label: 'deep', name: 'Not measured this session', measured: false },
  };
  orch._finishReveal();
  check('no-claim reveal still advances to email', orch.beat === 'email', orch.beat);
  check('no-claim reveal emits no named constellation dot', joins.length === 0, JSON.stringify(joins));
}
{
  const orch = makeOrch();
  const joins = [];
  orch.on('dot-join', (payload) => joins.push(payload));
  orch.beat = 'standby';
  orch.answers.archetype = 'steady';
  orch.reveal = {
    eegDerivedClaimsAllowed: true,
    archetype: { label: 'steady', name: 'Steady Burner', measured: true },
  };
  orch._finishReveal();
  check('measured reveal still emits its real archetype',
    joins.length === 1 && joins[0].archetype === 'steady', JSON.stringify(joins));
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
