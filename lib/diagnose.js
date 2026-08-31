/* ============================================================
   ZONE, THE FOCUS ROOM · diagnose.js
   The operator console's brain. Two pure functions, no dependencies, so it
   runs identically in the served page and (if ever needed) in Node.

   • diagnose(state)  -> { level, headline, detail, alerts[] }
       Reads a live snapshot of the room and returns, in plain language, what
       is wrong and how to fix it. Every alert is a real failure mode of THIS
       system with concrete steps, not generic advice.

   • humanize(channel, payload) -> {level, text, ...} | null
       Turns one raw telemetry event into a short, readable activity-log line
       (or null to drop noisy events). The operator never reads raw JSON.

   Design rule: an operator with no technical background should be able to act
   on every line without asking anyone.

   THE DISCONNECTION RULE (2026-08-31, after a live guest session)
   ------------------------------------------------------------
   This file is the only place allowed to tell an operator that the earbud
   link has dropped, and it may only do so on EVIDENCE that it dropped.
   The trail of that session (data/room.log) shows both buds up at ~248 Hz
   with 0.4% packet loss from 14:37:24 to the end, the orchestrator's own
   verdict `link.buds` true throughout and `link.lost` never true, while the
   console repeatedly announced a dropped link. Every claim below is now
   gated on one of:
       transportAlive   the 1 Hz per-bud heartbeat / stats are still arriving
       link.buds        the orchestrator's canonical connection verdict
       link.lost        the orchestrator's real-loss verdict
       budsEverUp       has a link EVER existed in this run
   Frame silence alone is NOT evidence of a dropped link: the analyser
   rejects whole minutes of windows during ordinary movement, and the beat
   flipping into `fit` or `reading` starts a stream that takes seconds to
   produce its first frame. Both read as silence and neither is a drop.
   ============================================================ */
(function (root) {
  'use strict';

  var LEVEL_RANK = { ok: 0, info: 1, warn: 2, bad: 3 };
  var pct = function (x) { return (x == null ? '\u2013' : Math.round(x) + '%'); };

  // What the room is doing right now, in words a non-engineer reads.
  var BEAT_PLAIN = {
    idle: 'Waiting for a guest', welcome: 'A guest is starting', fit: 'Seating the earbuds',
    intake: 'Guest answering questions', picker: 'Guest choosing a reading',
    reading: 'Guest is reading', strongest: 'Quick question before the reveal',
    standby: 'Showing the reveal on the TV', email: 'Guest entering their email',
    close: 'Wrapping up',
  };

  // Plain words for the SDK's own connection vocabulary. The raw strings
  // ("left_disconnected") used to be printed at the operator verbatim, which
  // reads as a fault even when it is the room's own redial working normally.
  var STATUS_PLAIN = {
    left_connected: { level: 'ok', text: 'The left earbud is linked' },
    right_connected: { level: 'ok', text: 'The right earbud is linked' },
    left_disconnected: { level: 'warn', text: 'The left earbud link dropped; the room is redialling it' },
    right_disconnected: { level: 'warn', text: 'The right earbud link dropped; the room is redialling it' },
    // fires when the engine shuts down or the operator presses Disconnect, so
    // it is a statement of fact, never an alarm
    disconnected: { level: 'info', text: 'No earbud is linked now' },
  };

  // Engine error codes the operator can actually act on. Anything not listed
  // falls through to the raw message rather than being dressed up as known.
  var ERROR_PLAIN = {
    no_buds: {
      level: 'warn', headline: 'No earbuds found',
      text: 'The scan did not find any Zone earbuds nearby.',
      fix: ['Wake both earbuds and keep them near the room computer.', 'Press Scan for earbuds, then Connect earbuds.'],
    },
    reconnect_failed: {
      level: 'warn', headline: 'The earbuds did not reconnect',
      text: 'The room tried several times and could not restore the earbud link.',
      fix: ['Reseat and wake both earbuds.', 'Press Connect earbuds once.', 'If that fails, return both buds to the case briefly, then try again.'],
    },
    no_eeg_data: {
      level: 'bad', headline: 'No EEG data is arriving',
      text: 'The earbuds linked, but their EEG stream did not produce data.',
      fix: ['Do not start a guest reading yet.', 'Disconnect and reconnect the earbuds while the room is idle.', 'If it repeats, open the activity log for the service-check detail.'],
    },
    sdk_missing: {
      level: 'bad', headline: 'The real signal engine is not installed',
      text: 'This machine cannot read the real earbuds until the engine is installed.',
      fix: ['Run Install Real Engine.command once.', 'Then close and reopen the Focus Room app.'],
    },
    engine_init_failed: {
      level: 'bad', headline: 'The real signal engine would not start',
      text: 'The installed signal engine failed during startup.',
      fix: ['Close and reopen the Focus Room app.', 'If it repeats, reinstall the real signal engine and check the activity log.'],
    },
    command_failed: {
      level: 'warn', headline: 'The requested action did not finish',
      text: 'The signal engine refused or could not complete the operator action.',
      fix: ['Check the room state and try the action once more.', 'If it repeats, read the activity log line immediately below it.'],
    },
  };

  function secs(ms) { return Math.max(1, Math.round(ms / 1000)) + 's'; }
  function roleName(role) {
    return role === 'tv' ? 'TV' : role === 'ipad' ? 'iPad'
      : role === 'ops' ? 'Operator console' : cap(role || 'Surface');
  }
  function plainCode(code) {
    var words = String(code || 'unknown issue').replace(/[_-]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function diagnose(s) {
    s = s || {};
    var alerts = [];
    var add = function (level, id, headline, plain, fix) {
      alerts.push({ level: level, id: id, headline: headline, plain: plain, fix: fix || [] });
    };
    var streaming = s.beat === 'fit' || s.beat === 'reading';

    // ---- what the room itself believes about the link -------------------
    // The orchestrator already refuses to move this on anything but explicit
    // evidence (see app/orchestrator.js, the CONNECTION contract). When it has
    // an opinion, the console must not contradict it.
    var roomBuds = (s.link && typeof s.link.buds === 'boolean') ? s.link.buds : null;
    var canonicalLost = !!(s.link && s.link.lost === true);
    // The 1 Hz per-bud heartbeat rides the BLE stats callback: if it is still
    // arriving, packets are still arriving, so nothing has dropped.
    var transportAlive = s.transportAlive === true;
    // "have we ever seen a frame in this streaming stretch" - absent callers
    // fall back to the frame clock so an old snapshot still reads correctly
    var everStreamed = (s.everStreamed != null) ? !!s.everStreamed : (s.lastFrameAgo != null);

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
    // A total-loss sentence requires a fact stronger than "no recent frame".
    // `link.lost` is the orchestrator's canonical verdict. The fallback is an
    // explicit both-down connection report, but only AFTER this console has seen
    // a bud up in this run; the first failed auto-connect is not a drop.
    var explicitTotalDrop = !!(s.budsEverUp && budsKnown && L === false && R === false);
    var roomReportedDrop = !!(s.budsEverUp && roomBuds === false);
    // A current ingest/heartbeat is newer, direct evidence that a cached down
    // state is no longer true. It wins until canonical state catches up.
    var liveContradiction = transportAlive || s.analysisAlive === true;
    var lossProven = !liveContradiction && (canonicalLost || explicitTotalDrop || roomReportedDrop);
    var oneBudDown = !!(s.budsEverUp && budsKnown
      && ((L === false && R === true) || (R === false && L === true)));
    if (s.discovered && s.discovered.length === 0 && !budsKnown && roomBuds !== true) {
      add('warn', 'no-buds', 'No earbuds found',
        'A scan finished and did not see any Zone earbuds nearby.',
        ['Make sure both earbuds are charged and switched on.',
         'Put them in / take them out of the case to wake them.',
         'Press Scan for earbuds, then Connect earbuds.']);
    } else if (lossProven && (streaming || s.beat === 'welcome')) {
      add('bad', 'buds-off', 'The earbud link dropped',
        'The room had a live earbud stream and now has explicit evidence that the link is down.',
        ['Check both buds are charged and seated in the ears.',
         'Give the automatic redial a few seconds.',
         'If it does not return, press Connect earbuds once.']);
    } else if (oneBudDown) {
      var side = !L ? 'left' : 'right';
      add('warn', 'one-bud', 'Only one earbud is linked',
        'The ' + side + ' earbud was linked earlier and is explicitly down now.',
        ['Reseat the ' + side + ' earbud.',
         'Check the ' + side + ' bud is charged.',
         'It should reconnect by itself once it is awake.']);
    } else if (budsKnown && L === false && R === false && !s.budsEverUp
      && (streaming || s.beat === 'welcome')) {
      add('warn', 'buds-waiting', 'The earbuds have not linked yet',
        'The room has not seen an earbud connection in this run. This is a first connection, not a dropped one.',
        ['Wake and seat both earbuds.', 'Press Scan for earbuds, then Connect earbuds.']);
    }

    // ---- signal actually flowing ----
    // TWO silences (2026-08-31, seen live on the console): if the analyser's
    // 1 Hz accounting is still arriving, samples ARE flowing and the earbuds
    // are fine - the analysis is rejecting what it hears (movement, settling).
    // Calling that a dropped link sent the operator to fix a connection that
    // was running at 248 Hz the whole time.
    var staleFrame = streaming && everStreamed && s.lastFrameAgo != null && s.lastFrameAgo > 6000;
    if (staleFrame && (s.analysisAlive || transportAlive)) {
      add('info', 'analysis-picky', 'Movement is pausing the analysis, the link is fine',
        'The earbud heartbeat or analyser is still updating. It is rejecting windows (movement or settling electrodes), not losing Bluetooth.',
        ['Nothing to reconnect: the Bluetooth link is healthy.',
         'If it lasts, ask the guest to settle and keep still for a few seconds.']);
    } else if (staleFrame && lossProven) {
      add('bad', 'signal-stall', 'The earbud signal stopped',
        'The room has explicit link-loss evidence and the last EEG frame was ' + secs(s.lastFrameAgo) + ' ago. The session is paused, not lost.',
        ['The earbud link dropped; the buds reconnect themselves.',
         'If nothing comes back in ~15s, gently reseat one earbud.',
         'You do not need to restart the session; it continues where it left off.']);
    } else if (staleFrame) {
      add('warn', 'signal-silent-unconfirmed', 'The EEG display has not updated',
        'The last frame was ' + secs(s.lastFrameAgo) + ' ago, but the room has not reported an earbud-link loss.',
        ['Do not disconnect the earbuds on this evidence alone.',
         'Watch the heartbeat and connection lines for a few seconds.',
         'If the room reports a real drop, follow the reconnect steps that appear.']);
    } else if (streaming && !everStreamed && (transportAlive || s.analysisAlive)) {
      add('info', 'first-frame', 'The earbuds are streaming; waiting for a clean frame',
        'Transport is updating, but the analyser has not accepted the first display frame yet.',
        ['Nothing to reconnect.', 'Ask the guest to settle for a few seconds.']);
    } else if (s.link && s.link.eeg === 'holding' && lossProven) {
      add('warn', 'holding', 'Waiting for the signal to come back',
        'The room confirmed a link loss and is holding the session open while it recovers. Nothing is lost.',
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
    if (s.lastError) {
      var mappedError = ERROR_PLAIN[s.lastError.code];
      var duplicate = mappedError && alerts.some(function (a) {
        return (s.lastError.code === 'no_buds' && a.id === 'no-buds')
          || (s.lastError.code === 'reconnect_failed' && a.id === 'buds-off');
      });
      if (mappedError && !duplicate) {
        add(mappedError.level, 'engine-' + s.lastError.code, mappedError.headline,
          mappedError.text, mappedError.fix);
      } else if (!mappedError && (s.lastError.msg || s.lastError.code)) {
        add('warn', 'engine-error', 'The signal engine reported a problem',
          s.lastError.msg || plainCode(s.lastError.code),
          ['See the activity log below for context.', 'If it repeats, restart the app.']);
      }
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
        if (p.hello) return { level: 'ok', text: roleName(p.hello.role) + ' surface ready' };
        // Electron changes TV pages by destroying one renderer/WebSocket and
        // opening the next. That routine navigation used to print a warning on
        // every beat. Link health comes from canonical session/state, not this.
        if (p.left) return { level: 'info', text: roleName(p.left.role) + ' surface left (page change or network move)' };
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
        if (m.status) {
          var status = STATUS_PLAIN[m.status];
          if (status) return { level: status.level, text: status.text };
          if (/^(left|right)_validation_failed$/.test(m.status)) {
            var which = m.status.indexOf('left_') === 0 ? 'left' : 'right';
            return { level: 'warn', text: 'The ' + which + ' earbud did not pass its connection check' };
          }
          return { level: 'info', text: 'Earbud connection update: ' + plainCode(m.status) };
        }
        if (m.leftConnected !== undefined) {
          var l = m.leftConnected, r = m.rightConnected;
          if (l && r) return { level: 'ok', text: 'Both earbuds connected' };
          // This single message cannot know whether a link existed before, so
          // it reports the state without inventing a drop. diagnose() combines
          // it with budsEverUp/canonical link state for the actionable verdict.
          if (!l && !r) return { level: 'info', text: 'No earbud link is active yet' };
          return { level: 'warn', text: 'Only the ' + (l ? 'left' : 'right') + ' earbud is linked' };
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
        var known = ERROR_PLAIN[m.code];
        if (known) return { level: known.level, text: known.text };
        return { level: 'bad', text: m.msg || ('Signal engine issue: ' + plainCode(m.code)) };
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
    if (!MAP[k]) return null;
    return { level: (k === 'session_abandoned' || k === 'buds_disconnected') ? 'warn' : 'info', text: MAP[k] };
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  var api = { diagnose: diagnose, humanize: humanize, BEAT_PLAIN: BEAT_PLAIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Diagnose = api;
})(typeof window !== 'undefined' ? window : this);
