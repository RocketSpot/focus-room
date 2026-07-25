# INSTRUCTIONS FOR THE REPLIT AGENT — set up "The Focus Room" from this zip

You are setting up a COMPLETE, WORKING application. It needs configuration,
not construction. Do not redesign, rewrite, reframe, or "modernize" anything.

## What this app is
A one-room brain-reading experience. A Node server (`app/web-main.js`) serves
three synchronized web surfaces over one HTTP + WebSocket port and supervises a
small Python simulator as a child process. One server = one shared room/session
(that is by design, not a bug).

## Setup steps (do exactly this)
1. Extract the zip into the workspace root (the `.replit` file, `package.json`,
   and `app/` must sit at the top level).
2. Runtimes: Node 20 and Python 3.11 (the shipped `.replit` already selects
   modules `nodejs-20` + `python-3.11`). The Python side is pure standard
   library — DO NOT pip-install anything, there are no Python dependencies.
3. `npm install --omit=dev` (runtime deps are only `react`, `react-dom`, `ws`;
   dev deps include Electron which is NOT needed on Replit — skip it).
4. Run. The shipped `.replit` run command is already correct:
   `[ -f ipad/dist/app.js ] || npm run build:ipad; node app/web-main.js`
   (the zip ships the prebuilt `ipad/dist/app.js`, so no build happens).
5. The server binds `0.0.0.0` and honors `PORT` automatically (falls back to
   4321). The console prints a banner with the three page paths when it's up.

## Verify it works (all three, in a browser)
- `/tv.html` — shows "The Focus Constellation" (the big-TV surface; it switches
  screens by itself during a session).
- `/ipad-flow.html?kiosk=1` — the guest's handheld flow, full-bleed.
- `/ops.html` — the operator console; within ~5 seconds its chips should read
  Signal engine **Ready**, an amber **SIMULATION** badge, and a green LIVE link.
- End-to-end proof: temporarily set env `FOCUSROOM_DEMO=1` and restart — a
  ghost guest walks a whole session on its own (watch /tv.html change screens).
  REMOVE that variable afterward so real visitors drive the iPad page instead.

## Deployment
Use a **Reserved VM** deployment (always-on, single instance, persistent disk).
Do NOT use Autoscale: it runs multiple stateless copies — multiple conflicting
"rooms" — and wipes the constellation memory on cold starts.

## Optional secrets (skip unless the owner provides them)
- `POSTMARK_API_KEY` + `FOCUSROOM_EMAIL_FROM` — real report emails. Without
  them, reports are safely written to `data/outputs/` instead of sent.

## Optional: REAL earbuds via the desktop bridge (only if the owner asks)
By default this deployment simulates the brain signal (a cloud VM has no
Bluetooth). If the owner wants REAL earbuds: set secrets
`FOCUSROOM_SIGNAL=bridge` and `FOCUSROOM_BRIDGE_TOKEN=<a long random secret>`
and restart. The room then runs NO Python at all and waits for the owner's
desktop (running `npm run bridge` next to the earbuds, with the same token)
to dial in and stream the real signal engine up. Nothing else changes.

## Hard rules — do not violate
- Do NOT add Express/Vite/Next or any framework; the server in `app/server.js`
  is complete and intentional.
- Do NOT touch the honesty layer (`app/honesty.js`) or any user-facing copy.
- Do NOT install Python packages or "fix" `sidecar/` — it runs as
  `python3 sidecar/main.py --simulate` spawned BY the Node process; it is not
  a separate service and needs no port of its own.
- Do NOT create a database. Persistence is JSON files under `data/` (created
  automatically; starting empty is CORRECT — the constellation begins fresh).
- Do NOT change `.replit` except, if strictly necessary, port mappings.
- If something fails, read the server console output first; the app logs the
  cause plainly (e.g. a missing python3 or a busy port).

That's the entire job: extract, install, run, verify the three URLs.
