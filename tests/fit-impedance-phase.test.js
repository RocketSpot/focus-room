'use strict';
// ============================================================
// The EXISTING signal check now opens with the real impedance phase.
// ------------------------------------------------------------
// The flow the guest experiences is unchanged: seat the buds, settle, see
// your waves, confirm. What changed is what the room is DOING in the first
// seconds: the lead-off tone runs and the worn verdict gets its chance
// before the stream takes over. Three exits, first one wins - the verdict
// lands, the guest moves ahead, or the cap fires. The invariant these
// checks defend: the guest is NEVER gated on the impedance check.
//
//   node tests/fit-impedance-phase.test.js
// ============================================================
process.env.FOCUSROOM_FIT_IMPEDANCE_CAP_MS = '80';   // before require: module constant
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Orchestrator } = require(path.join(__dirname, '..', 'app', 'orchestrator.js'));

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.error(' FAIL  ' + name + (detail ? ' >> ' + detail : '')); }
};

const mk = () => {
  const sent = [];
  const o = new Orchestrator({
    supervisor: { send: (t, p) => { sent.push(p && p.reason ? `${t}:${p.reason}` : t); return true; } },
    server: { broadcast: () => {} },
    log: () => {},
  });
  return { o, sent };
};
const seat = (o) => {
  o.onClientHello({ role: 'ipad', clientTime: Date.now() });
  o._budsConnected = true;   // the ordinary case: buds already connected
  o.onClientMessage({ type: 'guest/event', kind: 'earbud_seated', payload: {}, t: Date.now() }, 'ipad');
};
const seatNoBuds = (o) => {
  o.onClientHello({ role: 'ipad', clientTime: Date.now() });
  o.onClientMessage({ type: 'guest/event', kind: 'earbud_seated', payload: {}, t: Date.now() }, 'ipad');
};

// ---- 2026-08-31: the guest seats BEFORE the buds connect ----
// The real first hardware run of this flow: "seated" tapped ~20s before the
// buds advertised. The fit must not arm against nothing; the phase waits for
// the link, and the guest's own taps still outrank everything.
{
  const { o, sent } = mk();
  seatNoBuds(o);
  check('no buds yet: the tone is NOT armed against nothing',
    !sent.includes('start_fit'), sent.join(','));
  o.onSidecar({ type: 'eeg/connection', leftConnected: true, rightConnected: true, dropRateL: 0 });
  check('the buds connecting starts the deferred impedance phase',
    sent.includes('start_fit'), sent.join(','));
  o._clearSession();
}
{
  const { o, sent } = mk();
  seatNoBuds(o);
  o.onClientMessage({ type: 'guest/event', kind: 'baseline_start', payload: {}, t: Date.now() }, 'ipad');
  check('guest outruns the connection: straight to the stream attempt, never gated',
    sent.includes('start_session:signal_check') && !sent.includes('start_fit'), sent.join(','));
  check('and the baseline window opened regardless', !!o.baseline);
  o._clearSession();
}

// ---- exit 1: the worn verdict lands ----
{
  const { o, sent } = mk();
  seat(o);
  check('seating opens the impedance phase, not the stream',
    sent.includes('start_fit') && !sent.some((s) => s.startsWith('start_session')), sent.join(','));
  // Captured hardware shape from 2026-08-31: numerically below the old broad
  // worn threshold, but every estimator row explicitly says bad/no contact.
  const badQcChannels = {
    left: {
      ch1: { kohm: 1201.5, kohmRaw: 550.6, state: 'open', phase: 'bad', hint: 'no skin contact' },
      ch2: { kohm: 1014.4, kohmRaw: 493.2, state: 'open', phase: 'bad', hint: 'no skin contact' },
    },
    right: {
      ch1: { kohm: 2123.3, kohmRaw: 1122.4, state: 'open', phase: 'bad', hint: 'no skin contact' },
      ch2: { kohm: 1699.9, kohmRaw: 952.9, state: 'open', phase: 'bad', hint: 'no skin contact' },
    },
  };
  o.onSidecar({ type: 'fit/impedance', allGood: false, channels: badQcChannels,
    worn: { left: 'checking', right: 'checking' } });
  check('bad-QC/no-contact hardware evidence cannot hand over to the stream',
    !sent.some((s) => s.startsWith('start_session')), sent.join(','));
  o.onSidecar({ type: 'fit/impedance', allGood: true, channels: {}, worn: { left: 'good', right: 'good' } });
  check('the worn verdict hands over to the signal-check stream',
    sent.includes('start_session:signal_check'), sent.join(','));
  const n = sent.filter((s) => s === 'start_session:signal_check').length;
  o.onSidecar({ type: 'fit/impedance', allGood: true, channels: {} });
  check('a second allGood does not double-start the stream',
    sent.filter((s) => s === 'start_session:signal_check').length === n, sent.join(','));
  o._clearSession();
}

// Cross-language contract: the Python producer must feed the independent QC
// phase into WornGate and require both ears before emitting allGood. The Python
// behavioral test replays every captured row; these assertions prevent a
// future bridge edit from silently dropping that evidence again.
{
  const zoneSource = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'zone_source.py'), 'utf8');
  check('sidecar forwards each channel QC phase into WornGate',
    /c\["kohm"\], c\["state"\], c\["kohmRaw"\], c\["phase"\]/.test(zoneSource));
  check('sidecar allGood requires explicit good verdicts from both ears',
    /all\(verdict\.get\(side\) == "good" for side in \("left", "right"\)\)/.test(zoneSource));
}

// ---- exit 2: the guest moves ahead (NEVER gated) ----
{
  const { o, sent } = mk();
  seat(o);
  o.onClientMessage({ type: 'guest/event', kind: 'baseline_start', payload: {}, t: Date.now() }, 'ipad');
  check('the guest starting the baseline outranks the check (stream starts NOW)',
    sent.includes('start_session:signal_check'), sent.join(','));
  check('and the baseline window opened', !!o.baseline);
  o._clearSession();
}

// ---- a fast confirm during the phase disarms cleanly ----
{
  const { o, sent } = mk();
  seat(o);
  o.onClientMessage({ type: 'guest/event', kind: 'fit_confirmed', payload: {}, t: Date.now() }, 'ipad');
  check('confirming during the phase disarms the tone (stop_fit, no stream to stop)',
    sent.includes('stop_fit') && !sent.includes('stop_session'), sent.join(','));
  check('and the beat moved on to intake', o.beat === 'intake');
  o._clearSession();
}

// ---- exit 3: the cap (a bad or absent verdict can never hold the guest) ----
{
  const { o, sent } = mk();
  seat(o);
  setTimeout(() => {
    check('with NO verdict at all, the cap starts the stream anyway (never gated)',
      sent.includes('start_session:signal_check'), sent.join(','));
    o._clearSession();

    // ---- sidecar restart mid-phase re-arms the fit, not the stream ----
    const r = mk();
    seat(r.o);
    r.sent.length = 0;
    r.o.onSidecarReady();
    check('a sidecar restart during the phase re-arms the fit check',
      r.sent.includes('start_fit') && !r.sent.some((s) => s.startsWith('start_session')),
      r.sent.join(','));
    r.o._clearSession();

    // ---- allGood outside the fit beat stays inert ----
    const q = mk();
    q.o.onSidecar({ type: 'fit/impedance', allGood: true, channels: {} });
    check('an allGood outside the fit beat does nothing',
      !q.sent.some((s) => s.startsWith('start_session')), q.sent.join(','));

    console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'ALL GREEN'));
    process.exit(failures ? 1 : 0);
  }, 200);
}
