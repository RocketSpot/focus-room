# The Focus Room on Replit — the movement package

The room's brain was built served-first: the iPad flow, the operator console,
and every TV surface are already web pages riding one HTTP + WebSocket server.
On Replit that server runs headless (`app/web-main.js`) — same orchestrator,
same beats, same reveal pipeline, same honesty rules — with the deterministic
**simulated EEG source** driving sessions.

## What is exactly the same
- The full session flow: welcome → fit + baseline → intake → picker → reading
  (EEG-gated interruption) → processing → the four-read reveal → email → close.
- All three surfaces, now three URLs on one host:

  | Surface | URL |
  |---|---|
  | Big TV | `https://<your-repl>/tv.html` (open on the TV's browser, press F11) |
  | Guest iPad | `https://<your-repl>/ipad-flow.html?kiosk=1` |
  | Operator (the Ctrl+Shift+D console) | `https://<your-repl>/ops.html` |

- The constellation persists between sessions and **starts empty** — the web
  room begins with zero dots (fresh `data/` on the new host). To reset it at
  any time, delete `data/constellation.json` and reload the TV.
- The room sound: open `https://<your-repl>/room-audio.html` on the speaker
  device and tap once (browsers require a tap before audio; the room's own
  machine needed none).

## What physically cannot move (and how it degrades, honestly)
- **Real earbuds** — the Zone SDK talks native Bluetooth on the machine in the
  room; a cloud VM has no radio. By default the web room runs the sim source
  and says so (the amber "Simulation" badge on the ops console). **But the
  split room brings real buds to the web** — see "The desktop bridge" below.
- **The printed card / profile PNG** — rendered by the room app's own windows;
  on the web they are skipped with a log line. The emailed report still sends
  (minus the line image) once `POSTMARK_API_KEY` is set; without the key it
  falls back to writing the email to `data/outputs/` (dev-file provider).
- **One room** — exactly like the physical install, this is a single shared
  session. Two visitors on the guest URL are the same guest.

## Setup (once)
1. Push this repo to GitHub (or zip-upload) and **Import into Replit**. The
   `.replit` file already selects Node 20 + Python 3.11 and the run command.
   The sim sidecar is pure Python stdlib — no pip installs.
2. (Optional, for real emails) Secrets → add `POSTMARK_API_KEY` and
   `FOCUSROOM_EMAIL_FROM`.
3. Press **Run**. The console prints the three URLs. That's the whole setup.
4. To publish permanently: **Deploy → Reserved VM** (always-on, one instance,
   keeps its disk). Do NOT use Autoscale — it runs several stateless copies
   (several "rooms") and wipes the constellation on every cold start.

## The desktop bridge: room on Replit, REAL earbuds on your desk
The signal engine can live on the machine physically next to the Zone buds
while everything else stays on Replit:

1. On Replit, add secrets `FOCUSROOM_SIGNAL=bridge` and
   `FOCUSROOM_BRIDGE_TOKEN=<a long random secret>`, restart. The room now
   runs no Python and waits for your bridge.
2. On the desktop (this repo, next to the earbuds):
   ```
   set FOCUSROOM_ROOM_URL=https://<your-repl-url>
   set FOCUSROOM_BRIDGE_TOKEN=<the same secret>
   npm run bridge
   ```
   The bridge spawns the real sidecar (Zone SDK, Bluetooth) locally and
   streams it up over the room's own WebSocket. Commands (fit, session,
   the interruption mark) flow back down.
3. The ops badge now honestly reads **Real EEG** (it derives from the
   desktop sidecar's own hello — the room never assumes).

The token is required on both ends: a bridge with the wrong secret is
rejected loudly, so nobody else can inject signal into your room. If the
bridge's connection blips, the room PAUSES the stream (the same link
resilience as a Bluetooth drop) and resumes when it redials — a session is
never cancelled by the internet. EEG traffic is a couple of small messages
per second, so home-connection latency is irrelevant.

## Useful env knobs (same as the room)
`FOCUSROOM_REVEAL_STEP_MS` (per-read pacing), `FOCUSROOM_PROCESS_MS`,
`FOCUSROOM_PLATEAU_FALLBACK_MS`, `FOCUSROOM_SIM_SCENARIO=normal|flat|dropout`,
`FOCUSROOM_DEMO=1` (autopilot ghost guest), `FOCUSROOM_DATA_DIR`.
