'use strict';
// ============================================================
// update-check.js, tell a PORTABLE build when it has been superseded.
// ------------------------------------------------------------
// The portables are snapshots: nothing inside one ever updates itself. So on
// launch a packaged build asks one tiny question, "is there a newer one?", and
// if so shows a single dialog with a button to the download page. That is the
// entire feature. It never downloads anything, never blocks launch, never
// nags twice in a run, and stays completely silent when offline.
//
// WHERE THE VERSION LIVES. The repo is private, so its releases API needs
// auth, which a portable on a stranger's machine must never carry. The check
// therefore reads an UNLISTED gist that holds only three public-safe facts:
// a version string, a commit, and the download URL. Publishing a new portable
// updates the gist (tools/publish-portables.sh); committing code does not, so
// people are not nagged for every push, only when there is actually a new
// build to fetch.
//
// Dev runs (the Mac mini launchers run the live repo unpackaged) never check:
// they ARE the newest version by definition.
// ============================================================
const { app, dialog, shell } = require('electron');
const https = require('https');
const path = require('path');

const FEED = 'https://gist.githubusercontent.com/RocketSpot/9cf29c209321123e8bc0c305404a46b5/raw/focus-room-version.json';
const TIMEOUT_MS = 6000;

function fetchJson(url, redirects = 3) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': 'focus-room' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchJson(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function localBuild() {
  try { return require(path.join(__dirname, 'version.json')); }
  catch (_) { return { version: app.getVersion(), commit: null }; }
}

function newer(remote, local) {
  const pa = String(remote || '0').split('.').map(Number);
  const pb = String(local || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function checkForUpdate(log) {
  if (!app.isPackaged) return;                       // dev runs ARE current
  if (FEED.includes('VERSION_GIST_ID')) return;      // not wired: stay silent
  const remote = await fetchJson(FEED);
  if (!remote || !remote.version) return;            // offline or malformed: silent
  const local = localBuild();
  if (!newer(remote.version, local.version)) return;
  if (log) log(`update available: ${local.version} -> ${remote.version}`);
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'The Focus Room',
    message: 'This version is outdated.',
    detail: `You are running ${local.version} and version ${remote.version} is available.\n`
      + 'Download the new portable from GitHub, then replace this copy.',
    buttons: ['Open the download page', 'Not now'],
    defaultId: 0, cancelId: 1,
  });
  if (response === 0 && remote.url) shell.openExternal(remote.url);
}

module.exports = { checkForUpdate, newer };
