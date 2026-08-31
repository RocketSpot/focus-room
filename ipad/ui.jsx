/* ZONE, THE FOCUS ROOM · iPad shared UI primitives
   Composes with the bound Zone DS bundle (window.MonoLabel, window.I,
   window.DotDivider, loaded via _ds_bundle.js before this file).
   Exports to window for the screen files. Uses tokens.css vars.
   NOTE: the bundle's BgLights/TopBar/ZaineComposer/IOSDevice are the
   consumer mobile app's surfaces, out of scope here by brief (“build
   fresh Focus Room surfaces”); the kiosk fields below implement the
   same signature blur-light element at kiosk scale. */
(function () {
  const { useState, useEffect, useRef } = React;
  const e = React.createElement;
  const DS = window.ZoneDesignSystem_454d32 || {};

  // ---- tiny mono micro-label, delegates to the DS MonoLabel ----
  // (wider tracking than mobile: this kiosk is read at arm's length)
  function Mono({ children, color, style, caret }) {
    return e(window.MonoLabel, { style: { display: 'inline-block', color: color || 'var(--fg-muted)',
      letterSpacing: 'var(--tr-mono)', ...style } },
      children, caret ? e('span', { style: { opacity: 0.6, marginLeft: 4 } }, '›') : null);
  }

  // ---- the Zone dot mark ----
  function DotMark({ size = 12, glow = true, color = 'var(--c-signal)' }) {
    return e('span', { style: {
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      background: color, boxShadow: glow ? `0 0 ${size * 1.8}px ${size * 0.2}px rgba(221,202,142,0.5)` : 'none'
    } });
  }

  // ---- faint screen-corner dots ----
  function CornerDots({ dark = true }) {
    const c = dark ? 'var(--dot)' : 'rgba(20,20,20,0.5)';
    const pos = [[26, 26], [null, 26], [26, null], [null, null]];
    return e(React.Fragment, null, pos.map((p, i) => e('span', {
      key: i, style: {
        position: 'absolute', width: 3, height: 3, borderRadius: '50%', background: c, opacity: 0.28,
        left: p[0] != null ? p[0] : 'auto', right: p[0] == null ? 26 : 'auto',
        top: p[1] != null ? p[1] : 'auto', bottom: p[1] == null ? 26 : 'auto'
      }
    })));
  }

  // ---- primary / secondary / ghost pill button ----
  function PillBtn({ children, onClick, variant = 'primary', dark = false, disabled, style, full }) {
    const [press, setPress] = useState(false);
    const base = {
      fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: 17, letterSpacing: '-0.01em',
      borderRadius: 'var(--r-pill)', padding: '19px 30px', cursor: disabled ? 'default' : 'pointer',
      border: '1px solid transparent', transition: 'transform 90ms var(--ease-out), opacity 160ms, background 160ms',
      transform: press ? 'scale(0.975)' : 'none', opacity: disabled ? 0.35 : 1, width: full ? '100%' : 'auto',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10, userSelect: 'none', ...style
    };
    const variants = {
      primary: dark
        ? { background: 'var(--c-offwhite)', color: 'var(--c-near-black)' }
        : { background: 'var(--c-near-black)', color: 'var(--c-offwhite)' },
      secondary: dark
        ? { background: 'transparent', color: 'var(--fg)', border: '1px solid var(--hair-strong)' }
        : { background: 'transparent', color: 'var(--fg-light)', border: '1px solid rgba(20,20,20,0.18)' }
    };
    return e('button', {
      onClick: disabled ? null : onClick, onMouseDown: () => setPress(true),
      onMouseUp: () => setPress(false), onMouseLeave: () => setPress(false),
      style: { ...base, ...variants[variant] }
    }, children);
  }

  // ---- conversational option row: white rounded row + arrow (light field) ----
  function ArrowRow({ children, onClick, sub, selected }) {
    const [hover, setHover] = useState(false);
    return e('button', {
      onClick, onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
      style: {
        width: '100%', textAlign: 'left', background: 'var(--c-white)',
        border: selected ? '1.5px solid var(--c-near-black)' : '1px solid rgba(20,20,20,0.06)',
        borderRadius: 18, padding: '22px 24px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        boxShadow: hover ? '0 6px 22px rgba(20,20,20,0.07)' : '0 1px 3px rgba(20,20,20,0.04)',
        transform: hover ? 'translateY(-1px)' : 'none', transition: 'all 160ms var(--ease-out)'
      }
    },
      e('div', null,
        e('div', { style: { fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: 19, color: 'var(--c-near-black)', letterSpacing: '-0.01em' } }, children),
        sub ? e('div', { style: { fontFamily: 'var(--font-sans)', fontWeight: 300, fontSize: 15, color: 'var(--fg-light-muted)', marginTop: 5 } }, sub) : null
      ),
      e('span', { style: { color: 'var(--fg-light-muted)', flexShrink: 0, transform: hover ? 'translate(2px,-2px)' : 'none', transition: 'transform 160ms var(--ease-out)' } },
        e(Arrow, { size: 18 }))
    );
  }

  // ---- arrow icon, the DS Lucide helper (arrow-up-right) ----
  function Arrow({ size = 18, color = 'currentColor' }) {
    return e(window.I, { name: 'arrow-up-right', size, color });
  }

  // ---- step progress (tiny dots) ----
  function Progress({ total, idx, dark = true }) {
    return e('div', { style: { display: 'flex', gap: 7, alignItems: 'center' } },
      Array.from({ length: total }).map((_, i) => e('span', {
        key: i, style: {
          width: i === idx ? 18 : 6, height: 6, borderRadius: 'var(--r-pill)',
          background: i === idx ? (dark ? 'var(--c-signal)' : 'var(--c-near-black)')
            : (dark ? 'var(--hair-strong)' : 'rgba(20,20,20,0.16)'),
          transition: 'all 280ms var(--ease-out)'
        }
      })));
  }

  // ---- field wrappers with the signature ambient glow ----
  // Each field tells the shell what colour it is standing on. The guest canvas
  // is a scaled box, and any strip of the page the box does not cover paints
  // --room-ground (ipad-flow.html). Before this it painted near-black, so an
  // iPad viewport that disagreed with the canvas by any amount showed a black
  // band beside a cream screen. Matching the ground to the live field makes a
  // miss invisible rather than a bar across the screen.
  function useRoomGround(color) {
    useEffect(() => {
      const root = document.documentElement;
      root.style.setProperty('--room-ground', color);
    }, [color]);
  }

  function DarkField({ children, glow = true }) {
    useRoomGround('#0F0F0E');   // the bottom stop of this field's gradient
    return e('div', {
      style: {
        position: 'absolute', inset: 0, overflow: 'hidden',
        background: 'radial-gradient(130% 80% at 50% 116%, rgba(221,202,142,0.05), transparent 60%), linear-gradient(180deg, #1E1D1C 0%, #141414 60%, #0F0F0E 100%)',
        color: 'var(--fg)'
      }
    },
      glow ? e('div', { className: 'fr-light', style: { width: 460, height: 460, left: '50%', bottom: -220, transform: 'translateX(-50%)', background: 'rgba(221,202,142,0.16)' } }) : null,
      glow ? e('div', { className: 'fr-light', style: { width: 320, height: 320, left: -120, bottom: 40, background: 'rgba(221,202,142,0.05)' } }) : null,  /* signal gold, never orange: orange belongs to the interruption alone */
      e(CornerDots, { dark: true }), children);
  }

  function LightField({ children }) {
    useRoomGround('#EFEAE3');   // the bottom stop of this field's gradient
    return e('div', {
      style: {
        position: 'absolute', inset: 0, overflow: 'hidden',
        background: 'radial-gradient(120% 70% at 50% 120%, rgba(255,140,90,0.16), transparent 60%), radial-gradient(90% 60% at 12% 8%, rgba(255,210,180,0.20), transparent 55%), linear-gradient(180deg, #F5F3EF 0%, #F1EFEA 60%, #EFEAE3 100%)',
        color: 'var(--fg-light)'
      }
    }, e(CornerDots, { dark: false }), children);
  }

  // count-up number hook
  function useCountUp(target, ms = 900, run = true) {
    const [v, setV] = useState(run ? 0 : target);
    useEffect(() => {
      if (!run) { setV(target); return; }
      let raf, t0;
      const step = (t) => { if (!t0) t0 = t; const p = Math.min(1, (t - t0) / ms);
        setV(Math.round((1 - Math.pow(1 - p, 3)) * target)); if (p < 1) raf = requestAnimationFrame(step); };
      raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf);
    }, [target, run]);
    return v;
  }

  Object.assign(window, { Mono, DotMark, CornerDots, PillBtn, ArrowRow, Arrow, Progress, DarkField, LightField, useCountUp });
})();
