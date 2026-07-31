/* ZONE — THE FOCUS ROOM · iPad screens (part 1)
   Welcome · FitCheck · Intake · Picker */
(function () {
  const { useState, useEffect, useRef } = React;
  const e = React.createElement;
  const { Mono, DotMark, PillBtn, ArrowRow, Arrow, Progress, DarkField, LightField } = window;

  const wrap = (extra) => ({ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', ...extra });

  /* The real orb — the same gold state video the TV runs, so the object the
     guest meets on the iPad is the object they watch on the wall. Loops
     continuously and is never cropped (contain). Falls back to the soft glow
     alone if the asset can't load (e.g. the iPad opened straight off disk). */
  function Orb({ size = 320 }) {
    const [failed, setFailed] = useState(false);
    return e('div', { style: { position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
      e('div', { style: { position: 'absolute', width: size * 1.25, height: size * 1.25, borderRadius: '50%',
        filter: 'blur(60px)', background: 'radial-gradient(50% 50% at 50% 45%, rgba(221,202,142,0.34), transparent 70%)' } }),
      failed ? null : e('div', {
        // circular crop + radial mask: the clip is 16:9 with a not-quite-black
        // field, so contain left the orb tiny inside a visible grey rectangle.
        // Cover-crop into a circle, zoom until the orb fills it, and fade the
        // rim so the video melts into the dark field with no visible frame.
        style: {
          position: 'relative', width: '100%', height: '100%', borderRadius: '50%',
          overflow: 'hidden', pointerEvents: 'none',
          WebkitMaskImage: 'radial-gradient(circle, #000 66%, transparent 82%)',
          maskImage: 'radial-gradient(circle, #000 66%, transparent 82%)'
        }
      },
        e('video', {
          src: 'assets/orb/gold.mp4', muted: true, loop: true, autoPlay: true, playsInline: true,
          onError: () => setFailed(true),
          style: { width: '100%', height: '100%', objectFit: 'cover',
            transform: 'scale(1.9)', mixBlendMode: 'screen' }
        }))
    );
  }

  /* ---------------- WELCOME · the four onboarding slides ----------------
     What the guest needs before they begin: what this is, how we read it, what
     the rhythms mean, and that nothing here is a score. Deliberately four —
     enough to orient, short enough that nobody skims. It never mentions the
     interruption: anticipating it would change the very thing we measure. */

  // the five rhythms, in the room's shared band colours + the plain-word key
  const RHYTHMS = [
    { gl: 'δ', nm: 'Delta', ds: 'slow activity',        v: 'var(--w-delta)', hz: 6 },
    { gl: 'θ', nm: 'Theta', ds: 'internal attention', v: 'var(--w-theta)', hz: 10 },
    { gl: 'α', nm: 'Alpha', ds: 'calm alertness', v: 'var(--w-alpha)', hz: 15 },
    { gl: 'β', nm: 'Beta',  ds: 'active engagement',  v: 'var(--w-beta)',  hz: 22 },
    { gl: 'γ', nm: 'Gamma', ds: 'high-frequency activity',   v: 'var(--w-gamma)', hz: 30 },
  ];
  // a little wave glyph whose frequency matches the band it labels
  function WaveGlyph({ color, cycles, w = 76, h = 20 }) {
    let d = '';
    for (let i = 0; i <= 48; i++) {
      const x = (i / 48) * w;
      const y = h / 2 - Math.sin((i / 48) * cycles * Math.PI * 2) * (h / 2 - 3);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return e('svg', { width: w, height: h, style: { flex: 'none' } },
      e('path', { d, fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round' }));
  }

  /* WHERE THE SIGNAL COMES FROM — an honest topographic map.
     ------------------------------------------------------------------
     Drawn to the standard EEG topographic convention (EEGLAB `topoplot`): the
     head seen from ABOVE, nose at the top, pinnae as arcs at the sides, left
     hemisphere on the left, with faint 10-20 sites for orientation.

     WHAT IT CLAIMS, AND WHAT IT REFUSES TO.
     • Ear-EEG sensitivity is highest in the ipsi-lateral inferior and middle
       temporal lobe, and LOWEST frontally, centrally and posteriorly near the
       midline (Kappel et al. 2022, "Ear-EEG sensitivity modeling for neural
       sources and ocular artifacts"). So the field is drawn as two lateral
       temporal lobes falling off steeply toward the middle and the front. An
       earlier version of this diagram labelled a FRONTAL region, which had the
       finding exactly backwards — and ear electrodes DO pick up frontal-looking
       signal from eye movement, so that label named the one thing most likely
       to be an artifact rather than cortex.
     • It is NOT a smooth interpolated colour field. Spline-interpolating two
       sites produces a picture of the interpolator, not of the brain. What is
       shown is a modelled sensitivity falloff around the two real sites.
     • The bud contacts are drawn at the RIM, where they honestly fall: on a
       conventional head map, ear electrodes sit at or below the equator, out
       past where TP9/TP10 project. Their being off the edge is the point. */
  function CoverageMap() {
    const CX = 280, CY = 176, R = 116;
    // the two ear sites, just outside the equator where they really project
    const EAR = [[CX - R - 10, CY + 10], [CX + R + 10, CY + 10]];
    // a few 10-20 sites, purely for orientation
    const SITES = [[248, 78], [312, 78], [190, 116], [370, 116], [234, 176], [326, 176],
      [CX, CY], [190, 236], [370, 236], [248, 274], [312, 274]];
    return e('svg', { viewBox: '0 0 560 340', width: 528, height: 321, style: { flex: 'none' } },
      e('defs', null,
        ['L', 'R'].map((k, i) => e('radialGradient', { key: k, id: 'lobe' + k, gradientUnits: 'userSpaceOnUse',
          cx: EAR[i][0], cy: EAR[i][1], r: 112, fx: EAR[i][0], fy: EAR[i][1] },
          e('stop', { offset: '0%', stopColor: 'var(--w-theta)', stopOpacity: 0.5 }),
          e('stop', { offset: '30%', stopColor: 'var(--w-theta)', stopOpacity: 0.13 }),
          e('stop', { offset: '100%', stopColor: 'var(--w-theta)', stopOpacity: 0 }))),
        e('clipPath', { id: 'headClip' }, e('circle', { cx: CX, cy: CY, r: R }))),

      // nose (up) + pinnae — the marks that make a circle read as a head
      e('path', { d: `M ${CX - 15} ${CY - R + 6} L ${CX} ${CY - R - 20} L ${CX + 15} ${CY - R + 6}`,
        fill: 'none', stroke: 'var(--hair-strong)', strokeWidth: 1.4, strokeLinejoin: 'round' }),
      e('path', { d: `M ${CX - R + 2} ${CY - 26} C ${CX - R - 14} ${CY - 20} ${CX - R - 14} ${CY + 20} ${CX - R + 2} ${CY + 26}`,
        fill: 'none', stroke: 'var(--hair-strong)', strokeWidth: 1.4 }),
      e('path', { d: `M ${CX + R - 2} ${CY - 26} C ${CX + R + 14} ${CY - 20} ${CX + R + 14} ${CY + 20} ${CX + R - 2} ${CY + 26}`,
        fill: 'none', stroke: 'var(--hair-strong)', strokeWidth: 1.4 }),
      e('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: 'var(--hair-strong)', strokeWidth: 1.5 }),

      // the modelled sensitivity: two temporal lobes, fading toward the middle
      e('g', { clipPath: 'url(#headClip)' },
        e('circle', { cx: EAR[0][0], cy: EAR[0][1], r: 112, fill: 'url(#lobeL)' }),
        e('circle', { cx: EAR[1][0], cy: EAR[1][1], r: 112, fill: 'url(#lobeR)' })),

      // 10-20 sites, faint, for orientation only
      SITES.map(([x, y], i) => e('circle', { key: i, cx: x, cy: y, r: 2.4, fill: 'var(--fg-faint)', opacity: 0.5 })),

      // the two bud contacts, at the rim where they actually sit
      EAR.map(([x, y], i) => e('g', { key: i },
        e('circle', { cx: x, cy: y, r: 13, fill: 'none', stroke: 'var(--c-signal)', strokeOpacity: 0.3, strokeWidth: 1 }),
        e('circle', { cx: x, cy: y, r: 6, fill: 'var(--c-signal)' }))),

      // labels
      e('text', { x: CX, y: 30, textAnchor: 'middle', fill: 'var(--fg-faint)', fontFamily: 'IBM Plex Mono', fontSize: 10, letterSpacing: 1.6 }, 'WEAKEST HERE · FRONT AND MIDDLE'),
      e('text', { x: 24, y: CY + 58, fill: 'var(--w-theta)', fontFamily: 'IBM Plex Mono', fontSize: 11, letterSpacing: 1.6 }, 'STRONGEST HERE'),
      e('text', { x: 24, y: CY + 76, fill: 'var(--fg-faint)', fontFamily: 'IBM Plex Mono', fontSize: 10, letterSpacing: 1.4 }, 'THE TEMPORAL LOBES'),
      e('path', { d: `M 96 ${CY + 48} L ${EAR[0][0] - 4} ${CY + 26}`, stroke: 'var(--w-theta)', strokeWidth: 1, strokeOpacity: 0.4, fill: 'none' }),
      e('text', { x: 536, y: CY + 58, textAnchor: 'end', fill: 'var(--c-signal)', fontFamily: 'IBM Plex Mono', fontSize: 11, letterSpacing: 1.6 }, 'YOUR EARBUDS'),
      e('path', { d: `M 470 ${CY + 48} L ${EAR[1][0] + 4} ${CY + 26}`, stroke: 'var(--c-signal)', strokeWidth: 1, strokeOpacity: 0.4, fill: 'none' })
    );
  }

  const SLIDES = [
    { eyebrow: 'THE SESSION',    title: 'A quiet look at how your attention moves.' },
    { eyebrow: 'THE INSTRUMENT', title: 'The signal comes from just behind your ear.' },
    { eyebrow: 'THE RHYTHMS',    title: 'Your brain runs at five speeds at once.' },
    { eyebrow: 'BEFORE WE BEGIN', title: 'Everything is measured against you.' },
  ];

  function Welcome({ go }) {
    const [i, setI] = useState(0);
    const last = i === SLIDES.length - 1;
    const s = SLIDES[i];
    const body = { className: 't-body', style: { color: 'var(--fg-muted)', fontSize: 18, lineHeight: 1.55, marginBottom: 14 } };

    const panel = [
      // 01 — what this is. The orb sits BETWEEN the title and the body copy, so
      // the first thing the guest meets is the object they'll watch on the wall.
      e('div', { key: 'a', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 } },
        e(Orb, { size: 250 }),
        e('div', { style: { maxWidth: 560, textAlign: 'center' } },
          e('p', body, 'You’ll read something genuinely interesting for a few minutes. While you do, a small sensor in the earbud listens to the rhythms your brain is already making.'))),
      // 02 — the instrument
      e('div', { key: 'b', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 } },
        e(CoverageMap),
        e('div', { style: { maxWidth: 580, textAlign: 'center' } },
          e('p', body, 'Your neurons talk in small electrical pulses. When enough of them fire together, the rhythm reaches the surface, and the contacts resting in your ear pick it up.'),
          e('p', { className: 't-body-2', style: { color: 'var(--fg-faint)', fontSize: 15, lineHeight: 1.55 } },
            'The ear sits closest to your temporal lobe, so that is the part it hears best. It reads the surface nearby, never deep inside.'))),
      // 03 — the rhythms
      e('div', { key: 'c', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, width: '100%' } },
        e('div', { style: { width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 2 } },
          RHYTHMS.map((r) => e('div', { key: r.nm, style: {
            display: 'flex', alignItems: 'center', gap: 18, padding: '11px 4px',
            borderBottom: '1px solid var(--hair)' } },
            e(WaveGlyph, { color: r.v, cycles: r.hz / 5 }),
            e('span', { style: { fontFamily: 'var(--font-display)', fontSize: 22, color: r.v, width: 26 } }, r.gl),
            e('span', { className: 't-body', style: { fontSize: 17, color: 'var(--fg-strong)', width: 78 } }, r.nm),
            e('span', { className: 't-body-2', style: { fontSize: 15, color: 'var(--fg-muted)' } }, r.ds)))),
        e('p', { className: 't-body-2', style: { color: 'var(--fg-faint)', fontSize: 15, maxWidth: 520, textAlign: 'center' } },
          'All five run at once. You’ll see yours moving live on the screen across from you.')),
      // 04 — before we begin
      e('div', { key: 'd', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, maxWidth: 580 } },
        e('div', { style: { display: 'flex', flexDirection: 'column', gap: 18, width: '100%', textAlign: 'left' } },
          [['Nothing here is a score.', 'Every reading is compared to your own quiet baseline, never to anyone else and never as a diagnosis.'],
           ['There’s nothing to perform.', 'Breathe normally and sit comfortably. Read the way you’d read at home.'],
           ['We start with a quiet moment.', 'Fifteen still seconds with your eyes open, so we know what your calm looks like. Then you read.']]
            .map(([h, p], n) => e('div', { key: n, style: { display: 'flex', gap: 16, alignItems: 'flex-start' } },
              e(Mono, { style: { color: 'var(--c-signal)', paddingTop: 3, minWidth: 22 } }, '0' + (n + 1)),
              e('div', null,
                e('div', { className: 't-body', style: { fontSize: 17, color: 'var(--fg-strong)', marginBottom: 3 } }, h),
                e('div', { className: 't-body-2', style: { fontSize: 15, color: 'var(--fg-muted)', lineHeight: 1.5 } }, p)))))),
    ][i];

    return e(DarkField, null,
      e('div', { style: wrap({ padding: '64px 64px 56px', justifyContent: 'space-between', alignItems: 'center', textAlign: 'center' }) },
        // header: brand + where we are
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          e(DotMark, { size: 10 }), e(Mono, null, 'ZONE · BEFORE YOUR SESSION')),

        // the slide
        e('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22, flex: 1, justifyContent: 'center' } },
          e(Mono, { style: { color: 'var(--c-signal)' } }, `0${i + 1} · ${s.eyebrow}`),
          e('h1', { className: 't-h1', style: { color: 'var(--fg-strong)', fontSize: 42, lineHeight: 1.12, maxWidth: 700, margin: 0 } }, s.title),
          panel),

        // footer: back · progress · next
        e('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: 700 } },
          e('div', { style: { minWidth: 110, textAlign: 'left' } },
            i > 0 ? e('button', {
              onClick: () => setI(i - 1),
              style: { background: 'none', border: 'none', color: 'var(--fg-faint)', fontFamily: 'var(--font-mono)',
                fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', cursor: 'pointer', padding: '10px 4px' }
            }, 'Back') : null),
          e(Progress, { total: SLIDES.length, idx: i, dark: true }),
          e('div', { style: { minWidth: 110, display: 'flex', justifyContent: 'flex-end' } },
            e(PillBtn, { dark: true, onClick: () => (last ? go() : setI(i + 1)), style: { padding: '16px 32px' } },
              last ? 'I have the earbud in' : 'Next'))
        )
      )
    );
  }

  /* ---------------- FIT CHECK (dark, signal → ready) ---------------- */
  const BASELINE_S = 15;   // matches FOCUSROOM_BASELINE_MS on the orchestrator

  /* The baseline is fifteen still seconds. A counting number made that feel like
     a test being timed, so the only progress shown is a thin ring closing around
     an empty centre. It carries no digits and asks for nothing but the look. */
  function BaselineRing({ size = 168 }) {
    const R = size / 2 - 6;
    const C = 2 * Math.PI * R;
    const [closed, setClosed] = useState(false);
    // Start from a full gap and close it. DOUBLE rAF: a single frame's delay
    // can still land before the first paint commits (Safari coalesces the two
    // styles and the ring snaps shut instead of running its 15s close) — the
    // second rAF guarantees the open state painted first.
    useEffect(() => {
      let t2 = null;
      const t1 = requestAnimationFrame(() => { t2 = requestAnimationFrame(() => setClosed(true)); });
      return () => { cancelAnimationFrame(t1); if (t2 != null) cancelAnimationFrame(t2); };
    }, []);
    // The caption floats OUT OF FLOW beneath the ring, so the container's box is exactly
    // the ring's box and centring the container centres the RING itself — the thing the
    // guest is actually looking at — rather than the ring-plus-caption group.
    return e('div', { style: { position: 'relative', width: size, height: size, lineHeight: 0 } },
      e('svg', { width: size, height: size, style: { transform: 'rotate(-90deg)' } },
        e('circle', { cx: size / 2, cy: size / 2, r: R, fill: 'none', stroke: 'var(--hair-strong)', strokeWidth: 1.5 }),
        e('circle', { cx: size / 2, cy: size / 2, r: R, fill: 'none', stroke: 'var(--c-signal)',
          strokeWidth: 2.5, strokeLinecap: 'round', strokeDasharray: C,
          strokeDashoffset: closed ? 0 : C,
          style: { transition: `stroke-dashoffset ${BASELINE_S}s linear` } })),
      e('div', { style: { position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
        marginTop: 18, whiteSpace: 'nowrap', lineHeight: 1.4 } },
        e(Mono, { style: { color: 'var(--fg-faint)' } }, 'Recording your baseline')));
  }

  function FitCheck(props) {
    const { go, onBaselineStart } = props;
    const [phase, setPhase] = useState('listening'); // listening → ready
    const [left, setLeft] = useState(BASELINE_S);    // baseline countdown
    const [counting, setCounting] = useState(false);
    // Readiness is a short SETTLE, never a verdict on the signal: the room does not
    // inspect signal quality to let anyone through, and never says a word about it.
    // Standalone preview (file://) falls back to its own brief timer.
    useEffect(() => {
      if (location.host || props.ready != null) return;
      const t = setTimeout(() => setPhase('ready'), 1800); return () => clearTimeout(t);
    }, [props.ready]);
    const ready = props.ready != null ? props.ready : phase === 'ready';

    // The resting baseline: fifteen still seconds, eyes open, captured from the
    // signal check that is already streaming. It ends by advancing the beat, so
    // the orchestrator closes the window and saves it with the session.
    const startBaseline = () => {
      setCounting(true);
      if (onBaselineStart) onBaselineStart();
    };
    useEffect(() => {
      if (!counting) return;
      if (left <= 0) { go(); return; }
      const t = setTimeout(() => setLeft((n) => n - 1), 1000);
      return () => clearTimeout(t);
    }, [counting, left]);
    // THE BASELINE — the ring the guest actually stares at sits DEAD CENTRE of the
    // screen, on its own. The instruction floats near the top so nothing competes with
    // the ring for the middle of the display, and their eyes have one place to rest.
    if (counting) {
      return e(DarkField, null,
        e('div', { style: wrap({ padding: 0, justifyContent: 'center', alignItems: 'center', textAlign: 'center', position: 'relative' }) },
          e('div', { style: { position: 'absolute', top: 104, left: 0, right: 0, padding: '0 56px' } },
            e('h2', { className: 't-h2', style: { color: 'var(--fg-strong)', fontSize: 38, marginBottom: 14 } }, 'Stay just like that.'),
            e('p', { className: 't-body', style: { color: 'var(--fg-muted)', fontSize: 18, lineHeight: 1.5, maxWidth: 460, margin: '0 auto' } },
              'Watch the ring close, and breathe normally.')),
          e(BaselineRing, { size: 280 })));
    }

    return e(DarkField, null,
      e('div', { style: wrap({ padding: '88px 64px 72px', justifyContent: 'space-between', alignItems: 'center', textAlign: 'center' }) },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } }, e(DotMark, { size: 10, glow: false, color: 'var(--fg-muted)' }), e(Mono, null, 'Settling in')),
        // signal rings
        e('div', { style: { position: 'relative', width: 280, height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
          [0, 1, 2].map(i => e('div', { key: i, style: {
            position: 'absolute', width: 120 + i * 56, height: 120 + i * 56, borderRadius: '50%',
            border: `1px solid ${ready ? 'rgba(221,202,142,0.35)' : 'var(--hair-strong)'}`,
            opacity: ready ? 1 : 0.5,
            animation: ready ? 'none' : `pulse 2.6s ${i * 0.5}s var(--ease-in-out) infinite`,
            transition: 'border-color 600ms, opacity 600ms'
          } })),
          e('div', { style: {
            width: 90, height: 90, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: ready ? 'radial-gradient(circle at 40% 35%, #E9DDB6, #B6A876)' : '#262421',
            boxShadow: ready ? '0 0 50px 6px rgba(221,202,142,0.4)' : 'none', transition: 'all 700ms var(--ease-out)'
          } }, ready ? e(window.I, { name: 'check', size: 34, color: '#1E1D1C' }) : null)
        ),
        // NO SIGNAL VERDICTS. The room never tells a guest their signal is clear,
        // limited, or missing, and never asks them to wait on it — the copy is about
        // getting comfortable, nothing more. (Signal quality now reaches the operator
        // only.) The wall beside them already shows their live brainwaves.
        e('div', { style: { maxWidth: 520, minHeight: 200 } },
          e('h2', { className: 't-h2', style: { color: 'var(--fg-strong)', fontSize: 38, marginBottom: 16, transition: 'opacity 400ms' } },
            ready ? 'Ready when you are.' : 'Make yourself comfortable.'),
          e('p', { className: 't-body', style: { color: 'var(--fg-muted)', fontSize: 18, lineHeight: 1.5, marginBottom: 30 } },
            ready
              ? 'Now fifteen still seconds, so we know what your calm looks like. Everything after this is measured against it.'
              : 'Settle the earbuds so they sit snug, and get comfortable. The screen beside you is showing your live brainwaves.'),
          ready
            ? e(PillBtn, { dark: true, onClick: startBaseline, style: { padding: '20px 44px' } }, "I'm ready")
            : null
        )
      )
    );
  }

  /* ---------------- INTAKE (light, one question at a time) ---------------- */
  const QUESTIONS = [
    { eyebrow: 'On record · 01', q: 'When a notification pulls you out of focus, how big a deal is it: a blip, or a serious break?',
      opts: ['A blip, I barely notice', 'Somewhere in between', 'A serious break, it throws me'] },
    { eyebrow: 'On record · 02', q: 'How steady do you think your focus stays while you’re concentrating?',
      opts: ['Rock steady, start to finish', 'It drifts here and there', 'Honestly, all over the place'] },
    { eyebrow: 'On record · 03', q: 'How quickly do you settle into deep focus from a cold start?',
      opts: ['Almost right away', 'It takes me a few minutes', 'I need a long warm-up'] }
  ];
  function Intake({ go, answers, setAnswers }) {
    const [qi, setQi] = useState(0);
    const [mind, setMind] = useState(answers.mind || '');
    const isText = qi === QUESTIONS.length;
    const pick = (opt) => {
      const next = { ...answers, intake: { ...(answers.intake || {}), [qi]: opt } };
      setAnswers(next);
      setTimeout(() => setQi(qi + 1), 180);
    };
    return e(LightField, null,
      e('div', { style: wrap({ padding: '72px 60px 64px' }) },
        e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 56 } },
          e(Mono, { color: 'var(--fg-light-muted)' }, isText ? 'On record · one last thing' : QUESTIONS[qi].eyebrow),
          e(Progress, { total: 4, idx: qi, dark: false })
        ),
        e('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' } },
          e('h2', { className: 't-h2', style: { color: 'var(--fg-light)', fontSize: 36, lineHeight: 1.08, letterSpacing: '-0.02em', marginBottom: 44, maxWidth: 620 } },
            isText ? 'Last thing. What’s one thing on your mind right now?' : QUESTIONS[qi].q),
          isText
            ? e('div', null,
                e('textarea', {
                  value: mind, onChange: ev => setMind(ev.target.value), autoFocus: true, rows: 3,
                  placeholder: 'Whatever’s quietly pulling at you: a deadline, a message, a decision…',
                  style: { width: '100%', resize: 'none', background: 'var(--c-white)', border: '1px solid rgba(20,20,20,0.08)',
                    borderRadius: 18, padding: '24px 26px', fontFamily: 'var(--font-sans)', fontWeight: 300, fontSize: 21,
                    color: 'var(--c-near-black)', lineHeight: 1.4, outline: 'none', boxShadow: '0 1px 3px rgba(20,20,20,0.04)' }
                }),
                e('p', { className: 't-body-2', style: { color: 'var(--fg-light-muted)', marginTop: 16, fontSize: 14 } },
                  'We keep this quiet. It just helps the room feel like yours.'))
            : e('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
                QUESTIONS[qi].opts.map((o, i) => e(ArrowRow, { key: i, onClick: () => pick(o),
                  selected: (answers.intake || {})[qi] === o }, o)))
        ),
        isText ? e('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 28 } },
          e(PillBtn, { onClick: () => { const m = mind.trim() || 'the thing you came in carrying'; setAnswers({ ...answers, mind: m }); go({ mind: m }); }, disabled: false }, 'Pick something to read')) : null
      )
    );
  }

  /* ---------------- PICKER (light) ---------------- */
  const PIECES = [
    { id: 'keeper', title: 'The Keeper’s Last Entry', meta: '4 min · Mystery', sub: 'A lighthouse, a missing logbook, and three sets of footprints that shouldn’t exist.' },
    { id: 'octopus', title: 'How an Octopus Thinks', meta: '3 min · Science', sub: 'Nine brains, blue blood, and a kind of intelligence that evolved on another branch entirely.' },
    { id: 'cartographer', title: 'The Cartographer', meta: '4 min · Story', sub: 'She mapped a coastline that wasn’t on any chart, then had to decide whether to report it.' },
    { id: 'signal', title: 'The Signal from Nowhere', meta: '3 min · Open question', sub: 'For 72 seconds in 1977, a telescope heard something no one has explained since.' }
  ];
  function Picker({ go, answers, setAnswers }) {
    // pass the piece THROUGH go — aRef won't have it until the next render, and
    // the stale send made every guest's first tap on a reading card a dead tap
    const choose = (p) => { setAnswers({ ...answers, piece: p }); go({ piece: p }); };
    return e(LightField, null,
      e('div', { style: wrap({ padding: '72px 60px 56px' }) },
        e('div', { style: { marginBottom: 40 } },
          e(Mono, { color: 'var(--fg-light-muted)' }, 'Your reading · pick one'),
          e('h2', { className: 't-h2', style: { color: 'var(--fg-light)', fontSize: 38, marginTop: 18, letterSpacing: '-0.02em' } }, 'Choose something to fall into.'),
          e('p', { className: 't-body', style: { color: 'var(--fg-light-muted)', fontSize: 17, marginTop: 12, maxWidth: 540 } }, 'Each one is short and built to pull you in. Read it like you mean it. The screen across the room is already listening.')
        ),
        e('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 13, overflowY: 'auto' } },
          PIECES.map(p => e(ArrowRow, { key: p.id, onClick: () => choose(p), sub: p.sub },
            e('span', null, p.title, e('span', { style: { color: 'var(--fg-light-muted)', fontWeight: 400, fontSize: 14, marginLeft: 12, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' } }, p.meta)))),
          // ROADMAP (preview only): pasting your own material has no ingest step yet,
          // so 'own' dead-ends into a placeholder body. Hidden in device mode until
          // the paste + curated-body pipeline lands; kept here for design review.
          (typeof document !== 'undefined' && document.body.classList.contains('device')) ? null :
          e('button', { onClick: () => choose({ id: 'own', title: 'Your own material', meta: 'Your material' }),
            style: { marginTop: 6, background: 'transparent', border: '1px dashed rgba(20,20,20,0.2)', borderRadius: 18, padding: '20px 24px', cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            e('span', { style: { fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: 17, color: 'var(--fg-light-muted)' } }, 'Or read your own, paste a memo or one-pager'),
            e('span', { style: { color: 'var(--fg-light-muted)' } }, e(Arrow, { size: 17 })))
        )
      )
    );
  }

  Object.assign(window, { Welcome, FitCheck, Intake, Picker });
})();
