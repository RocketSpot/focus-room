// ZONE — THE FOCUS ROOM · iPad controller (synced) + standalone-preview fallback
// Drives which screen shows from the master clock's session/state, sends every
// guest action back to main timestamped on the shared clock, and falls back to
// linear manual stepping when opened as a file (no WebSocket).
(function () {
  const { useState, useEffect, useRef, useCallback } = React;
  const e = React.createElement;

  // ---- message contract (mirror of app/protocol.js) ----
  const C = { HELLO: 'client/hello', INTAKE: 'guest/intake', EVENT: 'guest/event', PING: 'ping' };
  const S = { STATE: 'session/state', SYNC: 'session/sync', IMPEDANCE: 'fit/impedance',
              BATTERY: 'fit/battery', CONNECTION: 'eeg/connection', INTERRUPT: 'interruption/fire',
              ARCHETYPE: 'session/archetype', OUTPUT: 'output/ready', REVEAL: 'reveal/data' };

  const SCREEN = { idle: 'Welcome', welcome: 'Welcome', fit: 'FitCheck', intake: 'Intake',
    picker: 'Picker', reading: 'Reading', strongest: 'StrongestQ', standby: 'Standby',
    email: 'Email', close: 'Close' };
  const ORDER = ['welcome', 'fit', 'intake', 'picker', 'reading', 'strongest', 'standby', 'email', 'close'];
  // idle maps to earbud_seated too: between guests the beat returns to 'idle'
  // (the iPad shows Welcome again), and the next guest's final Welcome tap must
  // start their session — without this entry it sent 'advance', which the
  // orchestrator drops at idle, wedging every guest after the first.
  const GO_EVENT = { idle: 'earbud_seated', welcome: 'earbud_seated', fit: 'fit_confirmed', reading: 'reading_finished',
    strongest: 'strongest_stretch_guess', standby: 'reveal_ack', email: 'email_entered', close: 'close_choice' };

  // ---- master-clock sync ----
  let clockOffset = 0;                 // masterNow() ≈ Date.now() + offset
  const masterNow = () => Date.now() + clockOffset;

  // ---- WebSocket bus ----
  // RECONNECTION POLICY. A Wi-Fi drop must never end a session or surface as an
  // error, so this reconnects forever and never gives up. Backoff is capped and
  // jittered: every surface in the room retrying on the same fixed 1s tick
  // meant a flapping access point got a synchronised burst from all of them at
  // once, which is exactly when it can least afford one. Jitter spreads them.
  const RETRY_MS = [500, 1000, 2000, 4000, 8000];
  function makeBus() {
    const listeners = new Set();
    let ws = null, connected = false, attempt = 0;
    function scheduleReconnect() {
      const base = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      attempt += 1;
      setTimeout(connect, base + Math.random() * base * 0.4);
    }
    function connect() {
      if (!location.host) return;      // file:// → standalone preview
      try { ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws'); } catch (_) { return scheduleReconnect(); }
      ws.onopen = () => {
        connected = true;
        attempt = 0;                   // a clean open resets the ladder
        const clientTime = Date.now();
        ws.send(JSON.stringify({ type: C.HELLO, role: 'ipad', clientTime, t: clientTime }));
        fire({ type: '_open' });
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m.type === S.SYNC) {
          const rtt = Date.now() - m.clientTime;           // round-trip on the LAN
          clockOffset = m.serverTime + rtt / 2 - Date.now();
        }
        fire(m);
      };
      ws.onclose = () => { connected = false; fire({ type: '_close' }); scheduleReconnect(); };
      ws.onerror = () => { try { ws.close(); } catch (_) {} };
    }
    function fire(m) { listeners.forEach((fn) => fn(m)); }
    return {
      connect, on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      send: (o) => { if (ws && connected) { try { ws.send(JSON.stringify(o)); } catch (_) {} } },
      get connected() { return connected; },
    };
  }
  const bus = makeBus();

  // ---- guest-action payloads (satisfy the orchestrator contract) ----
  // every send keeps a `from` field; the beats the orchestrator reads add their
  // own key: strongest→choice, email→email, close→door (default 'investor').
  function payloadFor(beat, a) {
    const p = { from: beat };
    if (beat === 'strongest') p.choice = a.strongestGuess;
    else if (beat === 'email') p.email = a.email;
    else if (beat === 'close') p.door = a.door || 'investor';
    return p;
  }
  function sendBeat(beat, a) {
    if (beat === 'intake') bus.send({ type: C.INTAKE, answers: a.intake || {}, onMind: a.mind || '', t: masterNow() });
    else if (beat === 'picker') bus.send({ type: C.INTAKE, reading: a.piece || null, t: masterNow() });
    else bus.send({ type: C.EVENT, kind: GO_EVENT[beat] || 'advance', payload: payloadFor(beat, a), t: masterNow() });
  }

  /* The one thing a guest ever sees about a dropped link: a quiet line at the
     bottom of whatever screen they're on. Never an error, never a dialog, never
     anything that asks them to do something about it — because there is nothing
     for them to do, and the session is not in danger. Deliberately in the muted
     grey of the reseat nudge rather than the interruption orange, which the room
     reserves for the one notification. */
  function LinkStrip({ reconnecting, findingSignal }) {
    if (!reconnecting && !findingSignal) return null;
    const label = findingSignal ? 'Finding your signal again' : 'Reconnecting';
    return e('div', {
      style: {
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 90,
        padding: '13px 24px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
        background: 'rgba(20,20,20,0.72)', backdropFilter: 'blur(8px)',
        animation: 'cardDrop 420ms var(--ease-out)',
      },
    },
      e('span', {
        style: {
          width: 7, height: 7, borderRadius: '50%', background: 'var(--fg-muted)',
          animation: 'pulse 1.8s var(--ease-in-out) infinite',
        },
      }),
      e('span', {
        style: {
          fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'rgba(240,238,232,0.72)',
        },
      }, label + ' · nothing is lost'));
  }

  function App() {
    const [synced, setSynced] = useState(false);
    const [beat, setBeat] = useState('welcome');
    const [answers, setAnswers] = useState({ archetype: 'deep' });
    const [fitAllGood, setFitAllGood] = useState(false);
    const [interruption, setInterruption] = useState(null);
    const [notice, setNotice] = useState(null);
    const [outputs, setOutputs] = useState({}); // {cardPrinted, profileReady, emailSent}
    // the guest's OWN reveal data, so the takeaway screen shows their real line
    // and the same figures the wall quoted rather than a generic archetype curve
    const [reveal, setReveal] = useState(null);
    // Shown only after the link has been down a few seconds. A momentary blip
    // reconnects well inside this, so the guest never sees a flicker of alarm
    // for something that already fixed itself.
    const [linkDown, setLinkDown] = useState(false);
    const linkTimer = useRef(null);
    const aRef = useRef(answers); aRef.current = answers;
    const bRef = useRef(beat); bRef.current = beat;
    const readingStartedRef = useRef(false); // fire reading_started once per session
    const pendingRef = useRef(null);          // one held action while the bus is down

    useEffect(() => {
      const off = bus.on((m) => {
        if (m.type === '_open') {
          setSynced(true);
          if (linkTimer.current) { clearTimeout(linkTimer.current); linkTimer.current = null; }
          setLinkDown(false);
          // bus reopened: flush the one action held while it was down (never fork).
          if (pendingRef.current) { const p = pendingRef.current; pendingRef.current = null; sendBeat(p.beat, p.answers); }
        }
        else if (m.type === '_close') {
          setSynced(false);
          if (!linkTimer.current) linkTimer.current = setTimeout(() => setLinkDown(true), 4000);
        }
        else if (m.type === S.STATE) {
          if (m.beat) setBeat(m.beat);
          setNotice(m.notice || null);
          // the streaming signal check has no impedance messages — the clean-read
          // verdict arrives on canonical state instead.
          if (typeof m.fitAllGood === 'boolean') setFitAllGood(m.fitAllGood);
          // self-heal: session/state carries the archetype, so a missed one-shot
          // session/archetype broadcast can't leave Close on the 'deep' default.
          if (m.archetype) setAnswers((a) => ({ ...a, archetype: m.archetype }));
        }
        else if (m.type === S.IMPEDANCE) setFitAllGood(!!m.allGood); // real-hardware fit path
        else if (m.type === S.INTERRUPT) {
          setInterruption({ onMind: m.onMind, t: m.t });
          // Phase 2A.2 correction 2: report the VISUAL marker back — the card's actual
          // committed-paint time (double-rAF), with the iPad's OWN monotonic clock
          // (performance.now, ipad-browser domain) alongside the master-clock wall time.
          // This is the visual half of the multimodal event; the audio-duck marker is
          // reported separately by room-audio. No sample-accurate claim is made.
          var reqMono = (typeof performance !== 'undefined' ? performance.now() : null);
          requestAnimationFrame(function () { requestAnimationFrame(function () {
            var renderedMono = (typeof performance !== 'undefined' ? performance.now() : null);
            bus.send({ type: C.EVENT, kind: 'notification_shown',
              payload: { shownAt: masterNow(), fireT: m.t,
                requestMonotonicMs: reqMono != null ? +reqMono.toFixed(3) : null,
                renderedMonotonicMs: renderedMono != null ? +renderedMono.toFixed(3) : null,
                clockDomain: 'ipad-browser' },
              t: masterNow() });
          }); });
        }
        else if (m.type === S.ARCHETYPE && m.label) setAnswers((a) => ({ ...a, archetype: m.label }));
        else if (m.type === S.REVEAL) {
          setReveal({ samples: m.samples || [], interruptT: m.interruptT, reads: m.reads || [] });
          // the reveal payload carries the computed archetype, so the takeaway
          // can never name a different one than the wall just showed
          if (m.archetype && m.archetype.label) setAnswers((a) => ({ ...a, archetype: m.archetype.label }));
        }
        else if (m.type === S.OUTPUT) setOutputs((o) => ({
          cardPrinted: m.cardPrinted != null ? m.cardPrinted : o.cardPrinted,
          profileReady: m.profileReady != null ? m.profileReady : o.profileReady,
          emailSent: m.emailSent != null ? m.emailSent : o.emailSent,
        }));
      });
      bus.connect();
      const hb = setInterval(() => bus.send({ type: C.PING, t: masterNow() }), 4000);
      return () => { off(); clearInterval(hb); };
    }, []);

    // tell main when the guest actually starts reading (timed against the stream).
    // Once per session — a reconnecting iPad that re-enters 'reading' must not
    // re-send and skew the timeline.
    useEffect(() => {
      if (synced && beat === 'reading' && !readingStartedRef.current) {
        readingStartedRef.current = true;
        bus.send({ type: C.EVENT, kind: 'reading_started', t: masterNow() });
      }
      if (beat === 'idle' || beat === 'welcome') readingStartedRef.current = false; // new session
      // PRIVACY: the room returns to idle when a guest leaves, but this iPad is
      // never reloaded between guests — so every answer stayed in state. The
      // next guest found the previous one's belief answers pre-selected, their
      // "what's pulling at you" text in the box, and their EMAIL prefilled and
      // valid, one tap from sending guest A's report to guest B. Wipe on idle.
      if (beat === 'idle') { setAnswers({ archetype: 'deep' }); setOutputs({}); setNotice(null); setReveal(null); }
      if (beat !== 'reading') setInterruption(null);
    }, [beat, synced]);

    // `overrides` carries answer fields set IN THE SAME tap that advances the
    // beat. aRef syncs on render, and React batches the tap's setAnswers until
    // after the handler — so a synchronous go() read the PRE-tap state: the
    // first tap on a reading card sent reading:null (a dead tap the guest had
    // to repeat), and the typed on-mind text was silently dropped. Screens must
    // pass such fields here rather than racing the render (the old setTimeout
    // dance in strongest/email worked by accident of timing).
    const go = useCallback((overrides) => {
      const b = bRef.current;
      const fresh = overrides && typeof overrides === 'object' && !overrides.target; // guard: event objects
      const a = fresh ? Object.assign({}, aRef.current, overrides) : aRef.current;
      if (!location.host) {                       // standalone preview (file://): step locally
        const i = ORDER.indexOf(b);
        setBeat(ORDER[Math.min(ORDER.length - 1, (i < 0 ? 0 : i) + 1)]);
        return;
      }
      if (!bus.connected) {                        // served but the bus blipped: hold, don't fork
        pendingRef.current = { beat: b, answers: a };
        return;
      }
      sendBeat(b, a);
    }, []);

    const key = SCREEN[beat] ? beat : 'welcome';
    const Comp = window[SCREEN[key]];

    useEffect(() => {
      window.__nav = {
        next: go,
        prev: () => { const i = ORDER.indexOf(bRef.current); setBeat(ORDER[Math.max(0, i - 1)]); },
        to: (n) => setBeat(ORDER[n] || 'welcome'),
        restart: () => { setBeat('welcome'); setAnswers({ archetype: 'deep' }); },
      };
      const now = document.getElementById('nowStep'); if (now) now.textContent = key;
    });

    return e('div', { className: 'screenwrap' },
      // the link strip lives OUTSIDE the keyed screen, so a reconnect mid-beat
      // doesn't remount it and restart its animation
      e(LinkStrip, { reconnecting: linkDown, findingSignal: notice === 'signal_lost' }),
      Comp ? e(Comp, {
        key: key,
        go, answers, setAnswers,
        // Gated on being SERVED, not on being currently connected. Gating on the
        // live socket meant a Wi-Fi blip during the fit check threw the screen
        // back from "Signal is clear" to "Finding a clean read…", undoing the
        // guest's progress for a blip that fixed itself a second later.
        // fitAllGood survives the drop in state, so the screen holds.
        ready: beat === 'fit' && location.host ? fitAllGood : undefined,
        // opens the 15s resting-baseline window on the orchestrator (the signal
        // check is already streaming, so this only marks the window)
        onBaselineStart: () => bus.send({ type: C.EVENT, kind: 'baseline_start', payload: {}, t: masterNow() }),
        // reading pace, stamped on the shared clock so it lines up with the EEG
        onScroll: (p) => bus.send({ type: C.EVENT, kind: 'reading_scroll', payload: { p }, t: masterNow() }),
        interruption: beat === 'reading' ? interruption : null,
        // reading gets the reseat coaching; fit gets the slow-fit nudge. Withheld
        // while the bus is down: the last notice we heard is stale by then, and
        // it would stack a second bottom strip under the reconnect one.
        notice: (beat === 'reading' || beat === 'fit') && synced ? notice : null,
        outputs: beat === 'close' ? outputs : undefined,
        reveal: beat === 'close' ? reveal : undefined,
      }) : e('div', { style: { color: '#fff', padding: 40 } }, 'missing: ' + key));
  }

  function boot() {
    window.ReactDOM.createRoot(document.getElementById('screen')).render(e(App));

    const params = new URLSearchParams(location.search);
    // Real iPad: launched from the home screen (navigator.standalone / the
    // standalone display-mode), forced with ?kiosk=1 — or simply a TOUCH
    // device on the plain URL (a guest's iPad in Safari used to get the
    // desktop bezel preview until someone remembered the query string).
    // ?kiosk=0 is the debug escape back to the framed preview on any device.
    const standalone = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    const touch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 1;
    const deviceMode = params.get('kiosk') === '0' ? false
      : (standalone || touch || params.get('kiosk') === '1');
    if (deviceMode) document.body.classList.add('device');

    function fit() {
      const room = document.getElementById('room'); if (!room) return;
      let s;
      if (deviceMode) {
        // COVER only when the screen is essentially the designed 816×1172
        // shape (within 2.5%) — on anything squarer (4:3 iPads) cover cropped
        // ~8% of the UI off the edges, so CONTAIN and let the room's own dark
        // field letterbox the sliver instead.
        const want = 816 / 1172;
        const have = window.innerWidth / Math.max(1, window.innerHeight);
        const near = Math.abs(have / want - 1) <= 0.025;
        s = (near ? Math.max : Math.min)(window.innerWidth / 816, window.innerHeight / 1172);
      } else {
        s = Math.min(window.innerWidth / 920, window.innerHeight / 1276);  // framed desktop preview
      }
      room.style.transform = 'scale(' + s + ')';
    }
    // iOS home-screen apps drop plain resize events on rotation — listen on
    // every channel a rotation or viewport change can announce itself.
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', () => setTimeout(fit, 60));
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
    window.addEventListener('pageshow', fit);
    fit();

    const byId = (id) => document.getElementById(id);
    const controls = byId('controls');
    if (params.get('kiosk') === '1' && controls) controls.classList.add('hide');
    const jump = byId('jump');
    if (jump) {
      ORDER.forEach((k, i) => { const o = document.createElement('option'); o.value = i; o.textContent = (i + 1) + '. ' + k; jump.appendChild(o); });
      jump.onchange = (ev) => window.__nav && window.__nav.to(parseInt(ev.target.value, 10));
    }
    if (byId('btnNext')) byId('btnNext').onclick = () => window.__nav && window.__nav.next();
    if (byId('btnPrev')) byId('btnPrev').onclick = () => window.__nav && window.__nav.prev();
    if (byId('btnRestart')) byId('btnRestart').onclick = () => window.__nav && window.__nav.restart();
    if (byId('btnHide') && controls) byId('btnHide').onclick = () => controls.classList.add('hide');
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'c' && controls) controls.classList.toggle('hide');
      if (ev.key === 'ArrowRight') window.__nav && window.__nav.next();
      if (ev.key === 'ArrowLeft') window.__nav && window.__nav.prev();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
