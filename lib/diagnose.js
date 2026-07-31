/* ============================================================
   ZONE, THE FOCUS ROOM · diagnose.js
   The operator console's brain. Two pure functions, no dependencies, so it
   runs identically in the served page and (if ever needed) in Node.

   • diagnose(state)  -> { level, headline, alerts[] }
       Reads a live snapshot of the room and returns, in plain language, what
       is wrong and how to fix it. Every alert is a real failure mode of THIS
       system with concrete steps, not generic advice.

   • humanize(channel, payload) -> string | null
       Turns one raw telemetry event into a short, readable activity-log line
       (or null to drop noisy events). The operator never reads raw JSON.

   Design rule: an operator with no technical background should be able to act
   on every line without asking anyone.
   ============================================================ */
(function (root) {
  'use strict';

  var LEVEL_RANK = { ok: 0, info: 1, warn: 2, bad: 3 };
  var pct = function (x) { return (x == null ? ', ' : Math.round(x) + '%'); };

  // What the room is doing right now, in words a non-engineer reads.
  var BEAT_PLAIN = {
    idle: 'Waiting for a guest', welcome: 'A guest is starting', fit: 'Seating the earbuds',
    intake: 'Guest answering questions', picker: 'Guest choosing a reading',
    reading: 'Guest is reading', strongest: 'Quick question before the reveal',
    standby: 'Showing the reveal on the TV', email: 'Guest entering their email',
    close: 'Wrapping up',
  };

  function diagnose(s) {
    s = s || {};
    var alerts = [];
    var add = function (level, id, headline, plain, fix) {
      alerts.push({ level: level, id: id, headline: headline, plain: plain, fix: fix || [] });
    };
    var streaming = s.beat === 'fit' || s.beat === 'reading';

    // ---- the signal engine (the Python sidecar) ----
    if (s.sidecar && s.sidecar.running === false) {
      add('bad', 'engine-down', 'The signal engine stopped',
        'The part that reads the earbuds is not running. It restarts itself automatically.',
        ['Wait a few seconds, it usually comes back on its own.',
         'If it keeps stopping, read the activity log below for the reason.',
         'Still stuck? Close and reopen the Focus Room app.']);
    } else if (s.sidecar && s.sidecar.restarts >= 3) {
      add('warn', 'engine-flaky', 'The signal engine keeps restarting',
        'It has restarted ' + s.sidecar.restarts + ' times. Something is making it fall over.',
        ['Check the Bluetooth adapter is plugged in and working.',
         'Look at the log below for a red error line.',
         'If it does not settle, restart the app.']);
    } else if (s.sidecar && s.sidecar.ready === false && s.sidecar.running) {
      add('info', 'engine-starting', 'The signal engine is starting up',
        'It is running but not ready yet. This takes a moment on launch.', []);
    }

    // ---- the earbud link (Bluetooth) ----
    var L = s.buds ? s.buds.left : null, R = s.buds ? s.buds.right : null;
    var budsKnown = L != null || R != null;
    if (s.discovered && s.discovered.length === 0 && !budsKnown) {
      add('warn', 'no-buds', 'No earbuds found',
        'A scan finished and did not see any Zone earbuds nearby.',
        ['Make sure both earbuds are charged and switched on.',
         'Put them in / take them out of the case to wake them.',
         'Press Discover, then Connect.']);
    } else if (budsKnown && !L && !R && (streaming || s.beat === 'welcome')) {
      add('bad', 'buds-off', 'The earbuds are not connected',
        'Neither earbud is linked right now, so there is no signal.',
        ['Check both buds are charged and seated in the ears.',
         'Press Discover, then Connect.',
         'If they were connected and dropped, they reconnect on their own, give it a moment.']);
    } else if (budsKnown && (!L || !R)) {
      var side = !L ? 'left' : 'right';
      add('warn', 'one-bud', 'Only one earbud is connected',
        'The ' + side + ' earbud is not linked. A clean read wants both.',
        ['Reseat the ' + side + ' earbud.',
         'Check the ' + side + ' bud is charged.',
         'It should reconnect by itself once it is awake.']);
    }

    // ---- signal actually flowing ----
    if (streaming && s.lastFrameAgo != null && s.lastFrameAgo > 6000) {
      add('bad', 'signal-stall', 'The signal stopped coming in',
        'The earbuds were streaming and went quiet ' + Math.round(s.lastFrameAgo / 1000) + 's ago. The session is paused, not lost.',
        ['The Bluetooth link probably dropped, the buds reconnect themselves.',
         'If nothing comes back in ~15s, gently reseat one earbud.',
         'You do not need to restart the session; it continues where it left off.']);
    } else if (s.link && s.link.eeg === 'holding') {
      add('warn', 'holding', 'Waiting for the signal to come back',
        'The room is holding the session open while the link recovers. Nothing is lost.',
        ['Give it a few seconds to reconnect on its own.',
         'If it persists, reseat an earbud.']);
    }

    // ---- contact quality (fit) ----
    if (s.beat === 'fit' && s.impedance && s.impedance.allGood === false) {
      add('warn', 'bad-contact', 'The earbud is not making clean contact',
        'The signal check is not clean yet, so the read has not started.',
        // Dry in-ear electrodes read through firm skin contact, the fix is
        // mechanical (seat, tip fit, stillness). NEVER add moisture: these buds
        // are shared between guests in an unattended room.
        ['Push each earbud in until it sits snug against the skin.',
         'Try a different ear tip so the bud sits flush.',
         'Ask the guest to hold still for a few seconds.']);
    } else if (streaming && s.signalQuality != null && s.signalQuality < 0.5) {
      add('warn', 'noisy', 'The signal is noisy',
        'Contact is weak or the guest is moving, so the read is rough.',
        ['Reseat the earbud that reads worst.',
         'Ask the guest to settle and stop talking.']);
    }

    // ---- battery ----
    if (s.battery) {
      var lowSide = null, lowPct = null;
      if (s.battery.leftPct != null && s.battery.leftPct < 20) { lowSide = 'left'; lowPct = s.battery.leftPct; }
      if (s.battery.rightPct != null && s.battery.rightPct < 20 && (lowPct == null || s.battery.rightPct < lowPct)) { lowSide = 'right'; lowPct = s.battery.rightPct; }
      if (lowSide) {
        add('warn', 'low-battery', 'The ' + lowSide + ' earbud battery is low',
          'It is at ' + pct(lowPct) + '. It may cut out mid-session.',
          ['Charge the ' + lowSide + ' earbud before the next guest.',
           'For now it will keep going until it dies.']);
      }
    }

    // ---- dropped packets ----
    var dp = worstDrop(s.stats);
    if (streaming && dp && dp.ratio > 0.05) {
      add('warn', 'packet-loss', 'The earbud signal is dropping out',
        Math.round(dp.ratio * 100) + '% of the ' + dp.dev + ' packets are being lost.',
        ['Move the laptop and the guest closer together.',
         'Turn off nearby Bluetooth devices that could interfere.',
         'Reseat the earbud if it continues.']);
    }

    // ---- last error the engine reported ----
    if (s.lastError && s.lastError.code === 'sdk_missing') {
      // a package built without the frozen engine (the cross-built macOS test
      // app) tried REAL mode on a machine that hasn't run the one-time install
      add('warn', 'sdk-missing', 'The real signal engine is not installed on this machine',
        'The room will not pretend: it stays here rather than simulating.',
        ['Run "Install Real Engine.command" (next to the app) once, then relaunch.',
         'Or double-click "Open in Simulation.command" to tour the room without earbuds.']);
    } else if (s.lastError && s.lastError.msg) {
      add('warn', 'engine-error', 'The signal engine reported a problem',
        s.lastError.msg, ['See the activity log below for context.',
          'If it repeats, restart the app.']);
    }

    // ---- simulation reminder (not a fault, but must be visible) ----
    if (s.mode === 'sim') {
      add('info', 'sim', 'This is SIMULATION mode',
        'The earbuds and brain data are fake. Nothing here is a real guest.',
        ['To use real earbuds, relaunch the room without simulation.']);
    }

    // sort worst-first
    alerts.sort(function (a, b) { return LEVEL_RANK[b.level] - LEVEL_RANK[a.level]; });

    // overall health + a one-line headline
    var top = alerts.filter(function (a) { return a.level === 'bad' || a.level === 'warn'; })[0];
    var level, headline;
    if (top) { level = top.level; headline = top.headline; }
    else {
      level = 'ok';
      headline = s.sidecar && s.sidecar.ready
        ? (BEAT_PLAIN[s.beat] || 'Everything looks healthy')
        : 'Getting ready';
    }
    return { level: level, headline: headline, alerts: alerts };
  }

  function worstDrop(stats) {
    if (!stats) return null;
    var best = null;
    ['dev1', 'dev2'].forEach(function (k) {
      var d = stats[k]; if (!d) return;
      var recv = d.received || 0, drop = d.dropped || 0, tot = recv + drop;
      if (tot < 50) return;               // too few packets to judge
      var ratio = drop / tot;
      if (!best || ratio > best.ratio) best = { dev: k === 'dev1' ? 'left' : 'right', ratio: ratio };
    });
    return best;
  }

  // ---- plain-language activity log ----
  function humanize(channel, p) {
    p = p || {};
    switch (channel) {
      case 'sidecar:status':
        if (p.running === false) return { level: 'bad', text: 'Signal engine stopped' };
        if (p.ready) return { level: 'ok', text: 'Signal engine ready' };
        if (p.running) return { level: 'info', text: 'Signal engine running' };
        return null;
      case 'sidecar:stderr': {
        // coerce: a non-string payload rendered "[object Object]" in the log
        const line = typeof p === 'string' ? p : (p && p.text) ? String(p.text) : '';
        if (!line.trim()) return null;
        return { level: 'muted', text: line };   // raw python line, dimmed
      }
      case 'server:retry':
        return { level: 'warn', text: 'Waiting for the network port (attempt ' + (p.attempt || '?') + ')' };
      case 'orch:beat':
        return { level: 'info', text: 'Room → ' + (BEAT_PLAIN[p.beat] || p.beat) };
      case 'orch:event':
        return eventLine(p);
      case 'surface:client':
        if (p.hello) return { level: 'ok', text: cap(p.hello.role) + ' connected' };
        if (p.left) return { level: 'warn', text: cap(p.left.role) + ' disconnected' };
        return null;
      case 'session:saved':
        return { level: 'ok', text: 'Session saved' };
      case 'outputs':
        if (p.cardPrinted) return { level: 'ok', text: 'Card printed' };
        if (p.emailSent) return { level: 'ok', text: 'Report emailed' };
        return null;
      case 'sidecar:message':
        return sidecarLine(p);
      default:
        return null;
    }
  }

  function sidecarLine(m) {
    switch (m.type) {
      case 'eeg/connection':
        if (m.status) return { level: 'info', text: 'Earbuds: ' + m.status };
        if (m.leftConnected !== undefined) {
          var l = m.leftConnected, r = m.rightConnected;
          if (l && r) return { level: 'ok', text: 'Both earbuds connected' };
          if (!l && !r) return { level: 'warn', text: 'Earbuds disconnected' };
          return { level: 'warn', text: 'Only the ' + (l ? 'left' : 'right') + ' earbud connected' };
        }
        return null;
      case 'fit/impedance':
        return m.allGood
          ? { level: 'ok', text: 'Contact is clean on both earbuds' }
          : null;   // don't spam while measuring
      case 'fit/battery':
        if (m.ok === false) return { level: 'warn', text: 'Earbud battery is low' };
        return null;
      case 'session/plateau':
        return { level: 'info', text: 'Focus settled, the interruption can fire' };
      case 'session/dip':
        return { level: 'info', text: 'Focus dipped' };
      case 'discovered':
        var n = (m.devices || []).length;
        return n
          ? { level: 'ok', text: 'Found ' + n + ' earbud' + (n > 1 ? 's' : '') }
          : { level: 'warn', text: 'Scan found no earbuds' };
      case 'error':
        return { level: 'bad', text: 'Error: ' + (m.msg || m.code || 'unknown') };
      case 'log':
        return m.msg ? { level: 'muted', text: m.msg } : null;
      default:
        return null;   // metrics/brainwaves/frame/stats are numbers, not log lines
    }
  }

  function eventLine(ev) {
    var k = ev && ev.kind;
    var MAP = {
      interruption_fired: 'The notification fired',
      buds_disconnected: 'Earbuds dropped (holding the session)',
      buds_reconnected: 'Earbuds reconnected',
      link_restored: 'The iPad reconnected',
      session_abandoned: 'Session ended (guest left)',
    };
    return MAP[k] ? { level: k === 'session_abandoned' ? 'warn' : 'info', text: MAP[k] } : null;
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  var api = { diagnose: diagnose, humanize: humanize, BEAT_PLAIN: BEAT_PLAIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Diagnose = api;
})(typeof window !== 'undefined' ? window : this);
