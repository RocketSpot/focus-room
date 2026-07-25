# The Focus Room — Architecture

Three processes, one installable app. The guest never sees Python or a terminal.

```
                         ┌────────────────────────────────────────────┐
                         │  Electron MAIN  (the brain, Mac Mini / PC)  │
                         │  app/main.js                               │
   spawns + supervises   │   • owns the master clock                  │
   ┌────────────────────▶│   • session state machine (Phase 3+)       │
   │   NDJSON / TCP       │   • generates card/profile, sends email    │
   │   127.0.0.1:<eph>    │   • persists constellation (SQLite, later) │
   │                     └───────────────┬───────────────┬────────────┘
   │                                     │ LAN HTTP+WS    │ Electron windows
   │                          0.0.0.0:4321 (app/server.js)│ (loadFile, asar)
┌──┴───────────────┐        ┌────────────▼──────┐   ┌─────▼──────────────┐
│ Python SIDECAR   │        │  iPad (Safari)    │   │  TV window         │
│ sidecar/main.py  │        │  ipad-flow.html   │   │  app/renderer/...  │
│  • Zone SDK v2   │        │  guest portrait   │   │  100" landscape    │
│  • engine (line) │        │  flow             │   │  live line/reveal  │
│  • sim source    │        └───────────────────┘   └────────────────────┘
└──────────────────┘
```

## Links

1. **Internal — Electron main ⇄ sidecar.** Localhost-only TCP (`net` server in
   `app/sidecar-supervisor.js`), newline-delimited JSON. Main listens on an
   ephemeral 127.0.0.1 port and hands it to the sidecar on argv; the sidecar
   connects back. If the sidecar dies, the supervisor restarts it with capped
   backoff. Never exposed off-box.
2. **External — main ⇄ surfaces.** One HTTP server (`app/server.js`) serves the
   design surfaces locally (no CDN, ever) with a WebSocket at `/ws`, bound to
   `0.0.0.0` so the iPad reaches it over the room LAN. The TV window is an
   Electron window that loads its renderer from the asar and connects to the
   same WebSocket — its rendering path is identical to a browser's.

## The message contract

`app/protocol.js` is the single source of truth, mirrored in
`sidecar/protocol.py`. Server→client: `session/state`, `eeg/frame`,
`eeg/connection`, `fit/battery`, `fit/impedance`, `interruption/fire`,
`reveal/data`, `reveal/step`, `constellation/data`, `constellation/join`,
`ui/cue`, `output/ready`. Client→server (timestamped): `client/hello`,
`guest/intake`, `guest/event`. Sidecar→main adds `hello`, `ready`, `eeg/metrics`,
`eeg/brainwaves`, `eeg/stats`, `session/plateau`, `session/dip`,
`session/archetype`, `session/samples`. Main→sidecar commands: `connect`,
`start_fit`, `stop_fit`, `start_session`, `stop_session`, `mark`, `test_signal`,
`disconnect`, `shutdown`.

Two notes on state that the surfaces depend on:

- **`session/state` is canonical, not a one-shot.** It carries the beat, the TV
  surface, the archetype, the coaching `notice`, and `fitAllGood` (the
  signal-check verdict). Anything a surface needs after a reload or resync must
  ride here — the streaming signal check emits no `fit/impedance`, so
  `fitAllGood` is the only way the iPad learns the read is clean.
- **`reveal/data` is built in one place.** The TV only loads `tv-reveal.html`
  once the beat turns standby, so it always misses the first broadcast and
  main.js re-sends on its `client/hello`. Both paths call
  `orchestrator.revealPayload()`; a second hand-written copy previously drifted
  and dropped the band stream, rendering the whole slideshow with empty charts.

## The session flow

`idle → welcome → fit → intake → picker → reading → strongest → standby →
email → close`. Two things live inside beats rather than as beats of their own:
the iPad's four onboarding slides (inside `welcome`) and the 15-second
eyes-open resting baseline (at the end of `fit`, where the signal check is
already streaming — `guest/event: baseline_start` just marks the window). The
baseline is saved with the session as `baseline`.

## The clock & sync model

Electron main owns the master clock. At session start the iPad does a sync
handshake to establish a shared reference, then stamps every guest event; main
maps those onto the EEG timeline so it always knows where the guest is and drives
the TV and iPad. Neither surface is ever manually advanced.

## The line

The visible line is `metrics.engagement` (native Zone v2 metric), smoothed on a
~4–8s window, updated ~1/s, plotted on a **relative** scale set from the guest's
own session — never absolute, no numbers. The engine (`sidecar/engine.py`) also
computes the `beta/(alpha+theta)` index and tracks `metrics.focus` as
diagnostic-only cross-checks. A dip counts only when the line stays below the
session's running band for more than a couple of seconds.

## Simulation & the diagnostic view

`--simulate` swaps the real source for `sidecar/sim_source.py`, which emits the
identical frame shapes (climb→plateau→dip→recover). It is opt-in and obviously
off in a packaged production build — never a silent fallback during a real
session. The hidden diagnostic overlay (Ctrl+Shift+D) shows raw bands, native
engagement, the computed index, focus, battery, the last impedance snapshot,
per-bud packet stats, and connection state, and can fire the SDK test signal.
