// ZONE, THE FOCUS ROOM · iPad controller (synced) + standalone-preview fallback
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
  // start their session, without this entry it sent 'advance', which the
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
     anything that asks them to do something about it, because there is nothing
     for them to do, and the session is not in danger. Deliberately in the muted
     grey of the reseat nudge rather than the interruption orange, which the room
     reserves for the one notification. */
  /* The one condition the room names to a guest: the earbuds fully lost their
     connection mid-session. Not a quality verdict, a hardware fact, and the
     guest needs a human. Full cover, blocks the screen, disappears on its own
     the moment the link is back. The session is held underneath, never reset. */
  function LinkLostCover({ lost }) {
    if (!lost) return null;
    return e('div', {
      style: {
        position: 'fixed', inset: 0, zIndex: 200, display: 'flex',
        flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 18, padding: '0 64px', textAlign: 'center',
        background: 'rgba(6,6,5,0.94)', backdropFilter: 'blur(14px)',
        animation: 'calmIn 420ms var(--ease-out)',
      },
    },
      e('div', { style: { width: 11, height: 11, borderRadius: '50%', background: 'var(--w-gamma)',
        boxShadow: '0 0 18px 2px rgba(224,166,87,0.5)', animation: 'pulse 1.8s var(--ease-in-out) infinite' } }),
      e('h2', { className: 't-h2', style: { color: 'var(--fg-strong)', fontSize: 40, maxWidth: 560 } },
        'The earbuds lost their connection.'),
      e('p', { className: 't-body', style: { color: 'var(--fg-muted)', fontSize: 18, lineHeight: 1.55, maxWidth: 480 } },
        'Wave the operator over. Your session is held exactly where it is, and it continues the moment the connection is back.'),
      e(Mono, { style: { color: 'var(--fg-faint)', marginTop: 8 } }, 'SESSION HELD'));
  }

  function LinkStrip({ reconnecting, findingSignal }) {
    if (!reconnecting && !findingSignal) return null;
    // never 'finding your signal', the room does not narrate the signal to a guest
    const label = 'Reconnecting';
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
    const [linkLost, setLinkLost] = useState(false);
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
          // the full-cover is driven by canonical state, so it appears and clears
          // with the actual link, not with this tab's own connectivity
          setLinkLost(!!(m.link && m.link.lost));
          // the streaming signal check has no impedance messages, the clean-read
          // verdict arrives on canonical state instead.
          if (typeof m.fitAllGood === 'boolean') setFitAllGood(m.fitAllGood);
          // self-heal: session/state carries the archetype, so a missed one-shot
          // session/archetype broadcast can't leave Close on the 'deep' default.
          if (m.archetype) setAnswers((a) => ({ ...a, archetype: m.archetype }));
          // and the chosen reading, so an iPad reloaded mid-session recovers the
          // guest's piece instead of honestly rendering "Your piece loads here".
          // Never overwrites a piece the guest picked on THIS device.
          if (m.reading) setAnswers((a) => (a.piece ? a : { ...a, piece: m.reading }));
        }
        else if (m.type === S.IMPEDANCE) setFitAllGood(!!m.allGood); // real-hardware fit path
        else if (m.type === S.INTERRUPT) {
          setInterruption({ onMind: m.onMind, t: m.t });
          // Phase 2A.2 correction 2: report the VISUAL marker back, the card's actual
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
          setReveal({
            samples: m.samples || [], interruptT: m.interruptT, reads: m.reads || [],
            archetype: m.archetype || null,
            // An explicit policy flag outranks the presence of a path. Keeping
            // the two separate lets Close distinguish "not measured" from the
            // operationally different "measured, but the line failed to load".
            measured: m.eegDerivedClaimsAllowed === false
              || (m.archetype && m.archetype.measured === false) ? false : true,
            dataQualityStatus: m.dataQualityStatus || null,
            stats: m.stats || null,
          });
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
    // Once per session, a reconnecting iPad that re-enters 'reading' must not
    // re-send and skew the timeline.
    useEffect(() => {
      if (synced && beat === 'reading' && !readingStartedRef.current) {
        readingStartedRef.current = true;
        bus.send({ type: C.EVENT, kind: 'reading_started', t: masterNow() });
      }
      if (beat === 'idle' || beat === 'welcome') readingStartedRef.current = false; // new session
      // PRIVACY: the room returns to idle when a guest leaves, but this iPad is
      // never reloaded between guests, so every answer stayed in state. The
      // next guest found the previous one's belief answers pre-selected, their
      // "what's pulling at you" text in the box, and their EMAIL prefilled and
      // valid, one tap from sending guest A's report to guest B. Wipe on idle.
      if (beat === 'idle') { setAnswers({ archetype: 'deep' }); setOutputs({}); setNotice(null); setReveal(null); }
      if (beat !== 'reading') setInterruption(null);
    }, [beat, synced]);

    // `overrides` carries answer fields set IN THE SAME tap that advances the
    // beat. aRef syncs on render, and React batches the tap's setAnswers until
    // after the handler, so a synchronous go() read the PRE-tap state: the
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
      e(LinkLostCover, { lost: linkLost }),
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
    // standalone display-mode), forced with ?kiosk=1, or simply a TOUCH
    // device on the plain URL (a guest's iPad in Safari used to get the
    // desktop bezel preview until someone remembered the query string).
    // ?kiosk=0 is the debug escape back to the framed preview on any device.
    const standalone = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    const touch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 1;
    const deviceMode = params.get('kiosk') === '0' ? false
      : (standalone || touch || params.get('kiosk') === '1');
    // both elements: the ground colour has to be on <html> too, because that is
    // what paints any strip the fixed #stage does not cover, and no selector
    // rooted at body.device can ever reach it.
    if (deviceMode) { document.body.classList.add('device'); document.documentElement.classList.add('device'); }

    // ============================================================
    // FILL THE WHOLE iPAD, whatever iPad it is.
    // ------------------------------------------------------------
    // The guest canvas is authored at 816x1172. Scaling that fixed box to fit any
    // screen left dark letterbox bars on every iPad whose shape is not 816:1172
    // (an iPad Pro 11" is ~0.70, a 10.2" is ~0.75, the design is 0.696), which is
    // exactly the "not full screen" problem.
    //
    // So: SCALE to cover the short axis, then STRETCH the canvas box on the long
    // axis to the real viewport. Layout inside the screen is flex/absolute, so the
    // extra height or width is absorbed by the room's own dark field and the
    // content stays centred, rather than being cropped or boxed. The result fills
    // the display edge to edge on every iPad size, and dvh keeps it honest when
    // Safari's bars come and go.
    // ============================================================
    const DESIGN_W = 816, DESIGN_H = 1172;
    const stageEl = document.getElementById('stage');

    // The LAYOUT viewport, measured off #stage itself. #stage is
    // position:fixed;inset:0, so its own box is by definition the area a fixed
    // element covers, whatever iPadOS currently believes the viewport to be.
    // Measuring the thing we are filling beats asking any of the three height
    // APIs, which disagree with each other exactly when the keyboard is up.
    function layoutBox() {
      const r = stageEl && stageEl.getBoundingClientRect();
      const w = (r && r.width) || window.innerWidth;
      const h = (r && r.height) || window.innerHeight;
      return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    }

    function fit() {
      const room = document.getElementById('room'); if (!room) return;
      const screenEl = room.querySelector('.screen');
      if (!deviceMode) {
        // framed desktop preview keeps the bezel and its fixed proportions
        const s = Math.min(window.innerWidth / 920, window.innerHeight / 1276);
        room.style.transform = 'scale(' + s + ')';
        if (screenEl) { screenEl.style.width = DESIGN_W + 'px'; screenEl.style.height = DESIGN_H + 'px'; }
        return;
      }
      // NEVER visualViewport.height. The software keyboard shrinks the VISUAL
      // viewport by ~350px while the layout viewport stays full height, so
      // sizing from it shrank the canvas the moment a guest tapped the on-mind
      // textarea or the email field, and #stage went on centring that short
      // canvas over a full-height screen: a band above it and a band below.
      // Worse, the shortened size survived the keyboard leaving and rode along
      // to the closing screen, which is why Deep Diver had a band at the bottom
      // with no keyboard anywhere near it. The keyboard overlays this app the
      // way it overlays a native one; it does not resize it.
      const box = layoutBox();
      // cover the narrow axis so type and touch targets stay the designed size
      const s = Math.max(box.w / DESIGN_W, box.h / DESIGN_H);
      // then give the canvas exactly the viewport, expressed in pre-scale units.
      // ceil, never floor: rounding the canvas DOWN leaves a hairline of shell
      // showing along an edge after the scale, and a hairline of black reads as
      // a broken app.
      if (screenEl) {
        screenEl.style.width = Math.ceil(box.w / s) + 'px';
        screenEl.style.height = Math.ceil(box.h / s) + 'px';
      }
      room.style.transform = 'scale(' + s + ')';
    }

    // iOS brings a focused input into view by SCROLLING THE LAYOUT VIEWPORT
    // underneath the visual one. #stage is pinned to the layout viewport, so
    // that scroll carried the whole room up off the top of the screen and left
    // the shell showing as a band under the status bar. Put the offset back and
    // undo the document scroll, so the room stays welded to what the guest can
    // actually see, keyboard or no keyboard.
    function anchor() {
      if (!deviceMode || !stageEl) return;
      const vv = window.visualViewport;
      const top = vv ? Math.round(vv.offsetTop) : 0;
      // only set a transform when there is an offset to correct: a transform on
      // #stage would otherwise become the containing block for the fixed link
      // strip and the lost-link cover
      stageEl.style.transform = top ? 'translateY(' + top + 'px)' : '';
      if (window.pageYOffset || window.pageXOffset) window.scrollTo(0, 0);
    }

    // Synchronous, deliberately. Coalescing this behind requestAnimationFrame
    // meant the canvas silently stopped re-measuring whenever the surface was
    // not painting (a backgrounded tab, a display asleep), and it came back at
    // the stale size. fit() is one rect read and three style writes; it is
    // cheaper than the bug.
    function relayout() { anchor(); fit(); }
    // iPadOS reports post-keyboard and post-rotation geometry late, in stages,
    // and the LAST reading is the one the canvas keeps. One reading taken mid
    // animation is how a dismissed keyboard left the canvas short for the whole
    // rest of the session. Re-measure while it settles as well as during.
    const SETTLE_MS = [60, 160, 360, 700];
    function relayoutSettling() { relayout(); SETTLE_MS.forEach((d) => setTimeout(relayout, d)); }

    // iOS home-screen apps drop plain resize events on rotation, listen on
    // every channel a rotation or viewport change can announce itself.
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', relayoutSettling);
    window.addEventListener('scroll', relayout, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', relayoutSettling);
      window.visualViewport.addEventListener('scroll', relayout);
    }
    window.addEventListener('pageshow', relayoutSettling);
    // the textarea on the on-mind screen and the email field are where iPadOS
    // moves the viewport, and neither focus nor blur reliably fires a resize on
    // its own on every iPadOS version.
    document.addEventListener('focusin', relayoutSettling);
    document.addEventListener('focusout', relayoutSettling);
    fit();

    // ============================================================
    // PORTRAIT ONLY. The room is a portrait object: the reading column, the orb
    // and the baseline ring are all composed for a tall screen. A guest who turns
    // the iPad sideways mid-session would get a broken composition, and iOS gives
    // a web app no way to force rotation. So we ask, with the calmest possible
    // animation: a phone-shaped mark that rotates upright, once, and stays.
    // The moment they turn it back the overlay leaves and nothing was lost.
    // ============================================================
    function watchOrientation() {
      if (!deviceMode) return;
      const el = document.getElementById('rotate');
      if (!el) return;
      const check = () => {
        // the LAYOUT box again, not visualViewport.height. With the keyboard up
        // the visual viewport of a portrait 11" iPad is shorter than it is wide,
        // so reading orientation off it told a guest typing their email to turn
        // the iPad upright while they were holding it upright.
        const box = layoutBox();
        const landscape = box.w > box.h * 1.06;   // hysteresis, ignore near-square wobble
        el.classList.toggle('on', landscape);
        document.body.classList.toggle('landscape', landscape);
        // iPadOS 16.4+ honours this in an installed (standalone) web app; it is a
        // no-op everywhere else, so the overlay is still the real guarantee.
        if (landscape && screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('portrait').catch(() => {});
        }
      };
      window.addEventListener('resize', check);
      window.addEventListener('orientationchange', () => setTimeout(check, 60));
      if (window.visualViewport) window.visualViewport.addEventListener('resize', check);
      check();
    }
    watchOrientation();

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
