'use strict';
// ============================================================
// tests/hardware-day.test.js — every defect the first real runs exposed,
// pinned so none of them can return. Each check names the forensic finding
// it comes from.
//   node tests/hardware-day.test.js
// ============================================================
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { Orchestrator } = require(path.join(__dirname, '..', 'app', 'orchestrator.js'));

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.error(' FAIL  ' + name + (detail ? ' >> ' + detail : '')); }
};
const mk = () => {
  const recs = [];
  const o = new Orchestrator({
    supervisor: { send: () => true },
    server: { broadcast: () => {} },
    log: () => {},
  });
  const origRecord = o._record.bind(o);
  o._record = (kind, t, p) => { recs.push(kind); return origRecord(kind, t, p); };
  return { o, recs };
};

// ---- 2026-08-29: rejection is not loss ----------------------------------------
// Both buds ran at ~240 Hz all session while the analyser rejected ~90% of
// windows (drift); the room called that a lost link, raised the iPad cover,
// and set sticky signalIssue. Silence with the analyser still processing is
// REJECTION: an honest gap, an operator log line, and nothing else.
{
  const { o, recs } = mk();
  o.beat = 'reading';
  o._eegSimulation = false;
  o._lastFrameAt = o.now() - 60000;                       // frames long quiet...
  o.onSidecar({ type: 'eeg/analysis-v1', windowsAccepted: 1, windowsDropped: 9,
    acceptedFraction: 0.1, dropReasons: { drift: 9 } });   // ...but windows processing
  o.onSidecar({ type: 'eeg/analysis-v1', windowsAccepted: 1, windowsDropped: 19,
    acceptedFraction: 0.05, dropReasons: { drift: 19 } });
  o._checkStall();
  check('rejection: the gap opens', o._eegDown === true && o._eegDownCause === 'rejection');
  check('rejection: NO sticky signalIssue', o.signalIssue !== true, String(o.signalIssue));
  const link = o._linkState();
  check('rejection: the room never claims the link is in trouble',
    link.lost === false && link.eeg !== 'holding', JSON.stringify(link));
  o._onStreamAlive();
  check('rejection: an accepted frame closes it cleanly',
    o._eegDown === false && o._eegDownCause === null);
}
{
  const { o } = mk();
  o.beat = 'reading';
  o._eegSimulation = false;
  o._lastFrameAt = o.now() - 60000;                        // frames quiet AND
  // no analysis ticks at all: the transport is genuinely dead
  o._checkStall();
  check('real loss: still the full story', o._eegDownCause === 'loss' && o.signalIssue === true);
  const link = o._linkState();
  check('real loss: holding + lost, exactly as before',
    link.eeg === 'holding' && link.lost === true, JSON.stringify(link));
}

// ---- H4b: a failed FIRST connect attempt is not a drop ------------------------
// The auto-connect watcher tries on its own before anything was ever up. A
// null -> false transition must not write the drop story (sticky signalIssue,
// buds_disconnected) into a guest's session that had a perfectly clean reading.
{
  const { o, recs } = mk();
  o._budsConnected = null;
  o.onSidecar({ type: 'eeg/connection', connected: false, leftConnected: false, rightConnected: false });
  check('first-ever connected:false still records the state', o._budsConnected === false);
  check('...but sets no sticky signalIssue', o.signalIssue !== true, String(o.signalIssue));
  check('...and fabricates no buds_disconnected event', !recs.includes('buds_disconnected'),
    recs.join(','));
  // a REAL drop (true -> false) keeps the full story
  o.onSidecar({ type: 'eeg/connection', leftConnected: true, rightConnected: true, dropRateL: 0 });
  o.onSidecar({ type: 'eeg/connection', connected: false, leftConnected: false, rightConnected: false });
  check('a genuine drop still sets signalIssue', o.signalIssue === true);
  check('a genuine drop still records buds_disconnected', recs.includes('buds_disconnected'));
}

// ---- H4: the CONNECTION contract ---------------------------------------------
{
  const { o, recs } = mk();
  o._budsConnected = null;
  // the 1 Hz heartbeat carries no `connected` field: it must NOT flip state
  o.onSidecar({ type: 'eeg/connection', leftConnected: true, rightConnected: true, dropRateL: 0 });
  check('heartbeat with both buds up reads as connected', o._budsConnected === true);
  // a failed connect result flips false...
  o.onSidecar({ type: 'eeg/connection', connected: false, leftConnected: false, rightConnected: false });
  check('an explicit connected:false reads as disconnected', o._budsConnected === false);
  // ...and the very next heartbeat used to flip it straight back (the phantom
  // 248-583ms reconnect pairs). With honest per-bud fields it stays down.
  o.onSidecar({ type: 'eeg/connection', leftConnected: false, rightConnected: false, dropRateL: 0 });
  check('a heartbeat with both buds down does NOT fabricate a reconnect', o._budsConnected === false);
  // a status-string message carries no evidence at all: state must not move
  o.onSidecar({ type: 'eeg/connection', status: 'left_validation_failed' });
  check('a status string never moves the connection state', o._budsConnected === false);
  o.onSidecar({ type: 'eeg/connection', leftConnected: true, rightConnected: false });
  check('one bud genuinely back reads as connected', o._budsConnected === true);
  check('the record carries no phantom pairs',
    recs.filter((k) => k === 'buds_reconnected').length <= 1, JSON.stringify(recs));
}

// ---- H2: frame anchors before the band row (sidecar send order) --------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'zone_source.py'), 'utf8');
  const i = src.indexOf('def _on_window');
  const body = src.slice(i, i + 3000);
  check('the sidecar sends FRAME before BRAINWAVES, so the first accepted window keeps its bands',
    body.indexOf('OUT.FRAME') < body.indexOf('OUT.BRAINWAVES'),
    'order reversed');
}

// ---- H1: the guest boundary --------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'zone_source.py'), 'utf8');
  const stop = src.slice(src.indexOf('async def stop_session'), src.indexOf('async def stop_session') + 1600);
  check('stop_session resets the analyser WITH references (the guest boundary)',
    /reset\(keep_references=False\)/.test(stop), 'guest 2 would be screened against guest 1');
  const start = src.slice(src.indexOf('async def start_session'), src.indexOf('async def start_session') + 1600);
  check('start_session keeps references (fit -> reading is the same ears)',
    /reset\(keep_references=True\)/.test(start));
  check('an in-flight reconnect dies with its session', /_reconnect_task/.test(stop) && /cancel\(\)/.test(stop));
}

// ---- H7: the analyser flushes across a reconnect ------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'zone_source.py'), 'utf8');
  const rec = src.slice(src.indexOf('async def _attempt_reconnect'), src.indexOf('async def _attempt_reconnect') + 3000);
  check('a reconnect flushes the analyser ring (references kept: same guest)',
    /_analyzer\.reset\(keep_references=True\)/.test(rec));
}

// ---- H6: the ladder has a cooldown -------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'zone_source.py'), 'utf8');
  check('the reconnect ladder has a cooldown', /RECONNECT_COOLDOWN_SEC/.test(src));
  check('the probe result is cached, so validating cannot cause the next disconnect',
    /_probe_cache/.test(src));
  check('the probe cache invalidates when a service proves dead',
    /_probe_cache\.clear\(\)/.test(src));
}

// ---- H9: telemetry now has consumers -----------------------------------------
{
  const { o } = mk();
  o.onSidecar({ type: 'eeg/analysis-v1', windowsAccepted: 40, windowsDropped: 12,
    acceptedFraction: 0.77, dropReasons: { drift: 8, step: 4 }, exponentMedian: 1.31 });
  check('the analysis counters are consumed, not dropped on the floor',
    o._analysisCounters && o._analysisCounters.acceptedFraction === 0.77
    && o._analysisCounters.dropReasons.drift === 8,
    JSON.stringify(o._analysisCounters));
  const rc = fs.readFileSync(path.join(__dirname, '..', 'app', 'room-core.js'), 'utf8');
  check('the diagnostic feed persists to disk', /room\.log/.test(rc) && /appendFile/.test(rc));
  check('the ops feed forwards the analysis counters', /SIDECAR_OUT\.ANALYSIS/.test(rc));
}

// ---- H3: a deferred interruption fires on recovery, not on the next poll -----
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'orchestrator.js'), 'utf8');
  check('a deferred interruption is remembered', /_interruptionDeferred = true/.test(src));
  check('recovery fires it within ~2s instead of the 6s poll',
    /_interruptionDeferred && this\.beat === 'reading'/.test(src) && /2000\)/.test(src));
}

console.log(failures === 0 ? '\nall hardware-day checks passed' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
