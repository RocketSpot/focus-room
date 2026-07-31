// ZONE, THE FOCUS ROOM · iPad vendor + DS shims (local-first, no CDN)
// Bundled FIRST by esbuild so window.React is set before the ui/screen IIFEs
// (which reference the React global) evaluate. Replaces the unpkg React/Babel,
// the Lucide CDN, and _ds_bundle.js, the screens only used window.MonoLabel
// and window.I from the DS, both shimmed here against tokens.css.
import React from 'react';
import { createRoot } from 'react-dom/client';

const e = React.createElement;

window.React = React;
window.ReactDOM = { createRoot };

// the DS mono micro-label → a tokens.css .t-mono span
window.MonoLabel = function MonoLabel(props) {
  return e('span', { className: 't-mono', style: props.style }, props.children);
};

// the DS icon helper → inline outline SVGs (only the icons the screens use)
const ICON_PATHS = {
  'arrow-up-right': 'M7 17 L17 7 M9 7 H17 V15',
  check: 'M5 12.5 L10 17.5 L19 6.5',
};
window.I = function I({ name, size = 18, color = 'currentColor', style }) {
  const d = ICON_PATHS[name] || ICON_PATHS['arrow-up-right'];
  return e(
    'svg',
    {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      style, 'aria-hidden': true,
    },
    e('path', { d })
  );
};
