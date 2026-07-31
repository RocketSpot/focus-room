// ZONE, THE FOCUS ROOM · iPad bundle entry (esbuild)
// Import order is load-bearing: _vendor sets window.React + the DS shims first,
// then ui defines the shared primitives, then the screens attach to window, then
// the controller mounts and wires the WebSocket sync. focusline.js is loaded
// separately (a standalone lib) before this bundle.
import './_vendor.js';
import './ui.jsx';
import './screens1.jsx';
import './screens2.jsx';
import './controller.jsx';
