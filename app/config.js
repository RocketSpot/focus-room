'use strict';
// ============================================================
// Zone, The Focus Room :: central config
// One place that resolves dev-vs-packaged paths, ports, and the
// simulation discipline. Everything else imports from here so the
// dev launch and the installed .exe behave identically.
//
// Loads under PLAIN NODE too (the web deployment has no Electron):
// the electron require is guarded, and every electron-derived value
// has a headless fallback.
// ============================================================
const path = require('path');
const os = require('os');
const fs = require('fs');

// --- local secrets (.env) -------------------------------------------------
// Reads a gitignored .env next to the project root into process.env, so keys
// like POSTMARK_API_KEY never live in source or in a committed config file.
// Deliberately dependency-free: the room is local-first and offline, and this
// is ~15 lines, not worth a runtime package (dotenv is only ever present here
// as a transitive dev dependency, so requiring it would break a clean install).
// A REAL environment variable always wins, so a launcher or CI can override.
// Never logs a value: a missing or malformed file is silently skipped.
(function loadDotEnv() {
  try {
    const envPath = path.join(path.resolve(__dirname, '..'), '.env');
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      if (key in process.env) continue;                  // the real environment wins
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch (e) { /* a bad .env must never stop the room from starting */ }
})();

// Electron is optional: present in the room build, absent on the web host.
let app = null;
try { app = require('electron').app || null; } catch (e) { app = null; }

const argv = process.argv.slice(1);
const hasFlag = (f) => argv.includes(f);

// --- dev vs packaged -----------------------------------------------------
const isPackaged = !!(app && app.isPackaged);
const isDev = hasFlag('--dev') || !isPackaged;

// --- SIMULATION ----------------------------------------------------------
// HARD RULE (Document.pdf + master prompt): a live guest only ever sees real
// signal. Simulation is opt-in behind an explicit flag and is structurally
// OFF in a packaged production build unless an operator deliberately sets the
// env var. Never a silent fallback during a real session.
const SIMULATE =
  hasFlag('--simulate') || process.env.FOCUSROOM_SIMULATE === '1';

// --- paths ---------------------------------------------------------------
// In dev, the repo root is the parent of app/. In a packaged build, the
// served web surfaces and the frozen sidecar live under resources/.
const repoRoot = path.resolve(__dirname, '..');
const resourcesPath = process.resourcesPath || repoRoot;

const isWin = process.platform === 'win32';

// The served web root (TV/iPad/card/profile surfaces + tokens + focusline).
const webRoot = isDev ? repoRoot : path.join(resourcesPath, 'webroot');

// The Python sidecar:
//  - dev:  run sidecar/main.py with the project venv interpreter
//          (FOCUSROOM_PYTHON overrides, the web host has no venv, just
//          a stock python3; the sim path is pure stdlib)
//  - prod: run the PyInstaller-frozen standalone binary from resources/sidecar
function resolveSidecar() {
  if (isDev) {
    const venvPython = isWin
      ? path.join(repoRoot, 'venv', 'Scripts', 'python.exe')
      : path.join(repoRoot, 'venv', 'bin', 'python');
    return {
      command: process.env.FOCUSROOM_PYTHON || venvPython,
      baseArgs: [path.join(repoRoot, 'sidecar', 'main.py')],
      // a real on-disk dir; the sidecar's sibling modules are on sys.path[0]
      cwd: repoRoot,
      frozen: false,
    };
  }
  // PyInstaller onedir: resources/sidecar/zone-sidecar/zone-sidecar(.exe)
  const exeName = isWin ? 'zone-sidecar.exe' : 'zone-sidecar';
  const command = path.join(resourcesPath, 'sidecar', 'zone-sidecar', exeName);
  // PyInstaller cannot cross-compile, so a package built on another OS (the
  // Windows-built macOS test app) ships WITHOUT a frozen sidecar. The sidecar
  // SOURCES ride along as resources/sidecar-src (including the pure-python
  // Zone SDK), so REAL earbuds work as soon as the one-time install has laid
  // down the compiled deps (bleak/scipy/numpy) in the app-managed venv.
  // Preference: FOCUSROOM_PYTHON > the app venv (real-capable) > system
  // python3 (which reports sdk_missing honestly in real mode; sim only when
  // explicitly launched with FOCUSROOM_SIMULATE=1).
  const fs = require('fs');
  if (!fs.existsSync(command)) {
    const srcMain = path.join(resourcesPath, 'sidecar-src', 'main.py');
    if (fs.existsSync(srcMain)) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const appVenvPy = process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'zone-focus-room', 'venv', 'bin', 'python3')
        : isWin
          ? path.join(process.env.APPDATA || home, 'zone-focus-room', 'venv', 'Scripts', 'python.exe')
          : path.join(home, '.local', 'share', 'zone-focus-room', 'venv', 'bin', 'python3');
      const command2 = process.env.FOCUSROOM_PYTHON
        || (fs.existsSync(appVenvPy) ? appVenvPy : (isWin ? 'python' : 'python3'));
      return {
        command: command2,
        baseArgs: [srcMain],
        cwd: path.dirname(srcMain),
        frozen: false,
      };
    }
  }
  return {
    command,
    baseArgs: [],
    // NEVER repoRoot here, in a packaged app that resolves INSIDE app.asar,
    // which is not a real directory and makes spawn() fail. Use the frozen
    // binary's own onedir folder.
    cwd: path.dirname(command),
    frozen: true,
  };
}

// --- ports ---------------------------------------------------------------
// LAN-facing HTTP + WebSocket (the iPad opens this in Safari; the TV window
// connects to it too). Bound to 0.0.0.0 so the iPad on the room LAN reaches it.
// Cloud hosts (Replit) inject PORT, honor it so the deployment Just Works.
const LAN_PORT = parseInt(
  process.env.FOCUSROOM_LAN_PORT || process.env.PORT || '4321', 10);

// Internal localhost-only control/data link between Electron main and the
// sidecar. 0 = OS-assigned ephemeral port; the chosen port is handed to the
// sidecar via --port. Never exposed off-box.
const SIDECAR_HOST = '127.0.0.1';
const SIDECAR_PORT = parseInt(process.env.FOCUSROOM_SIDECAR_PORT || '0', 10);

// --- writable data dir (sqlite, session records, generated outputs) ------
// FOCUSROOM_DATA_DIR overrides (point it at a persistent volume on a cloud
// host, and a FRESH dir gives the web room its own empty constellation).
const dataDir = process.env.FOCUSROOM_DATA_DIR
  || (isDev || !app
    ? path.join(repoRoot, 'data')
    : path.join(app.getPath('userData'), 'data'));

// Raw-EEG loopback policy (finding #5 credential-containment hardening). Loopback-only by
// DEFAULT. A non-loopback raw connection needs an explicit dev opt-in (FOCUSROOM_ALLOW_REMOTE_RAW=1)
// that is IGNORED in packaged production AND during validation (FOCUSROOM_VALIDATION=1). Pure +
// exported so it is unit-testable independently of the launch environment.
function rawLoopbackRequired({ isPackaged: pk, validation, allowRemote } = {}) {
  const allow = allowRemote === true && pk !== true && validation !== true;
  return !allow;   // secure default: loopback-only
}
const RAW_REQUIRE_LOOPBACK = rawLoopbackRequired({
  isPackaged,
  validation: process.env.FOCUSROOM_VALIDATION === '1',
  allowRemote: process.env.FOCUSROOM_ALLOW_REMOTE_RAW === '1',
});

module.exports = {
  isDev,
  isPackaged,
  isWin,
  SIMULATE,
  rawLoopbackRequired,
  RAW_REQUIRE_LOOPBACK,
  repoRoot,
  resourcesPath,
  webRoot,
  dataDir,
  hostname: os.hostname(),
  sidecar: resolveSidecar(),
  net: { LAN_PORT, SIDECAR_HOST, SIDECAR_PORT },
};
