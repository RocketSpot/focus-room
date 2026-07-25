# Zone — The Focus Room

One guest at a time sits in a dark room, puts in one Zone EEG earbud, and reads a
short gripping piece on an iPad while a 100-inch TV shows their focus as one calm
live line. Partway through, one interruption fires automatically; the line dips
and recovers. Then the TV replays their line annotated and walks four reads, and
the guest leaves with a printed card, a shareable profile, and an emailed report.
**There is no operator. The system runs itself.**

An installable desktop app (Electron + a bundled Python sidecar running the Zone
SDK) plus a paired iPad web client served over the room LAN. Identical on Windows
and macOS.

## Quick start

```bash
npm install
npm run dev        # Electron + sidecar in SIMULATION (no buds)
```

In simulation the room **waits for you**: open the iPad URL printed in the
console (same machine or any browser on the LAN), tap through the flow — seat
the earbuds, pass the signal check, answer, pick a reading — and the sim
sidecar fakes the earbuds and EEG at every step. Nothing plays itself. If you
ever want an unattended attract-loop (a full fake session cycling on repeat),
launch with `FOCUSROOM_DEMO=1`; a real tap takes over from it instantly.

Press **Ctrl+Shift+D** for the hidden diagnostic view. The iPad URL prints in the
console. To build the Windows installer: `npm run dist:win`.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**, **[docs/BUILD.md](docs/BUILD.md)**,
and **[docs/SETUP-SERVICES.md](docs/SETUP-SERVICES.md)** (Postmark email, printing,
the licensed display font — all optional).

## Principles (non-negotiable)

- **Honest.** Every value a guest sees traces to live signal, or it is omitted.
  Relative to their own session only — never an absolute/clinical score, never a
  to-the-second figure, never "felt vs measured". Enforced in the honesty copy layer.
- **Local-first.** The whole core loop runs on the room LAN with no internet. The
  only outbound call is the email send. All fonts and assets are bundled.
- **A precise instrument.** Warm-gray monochrome, one orange accent, large Neue
  Montreal display type, wide negative space, one calm line. Nothing that looks
  AI-generated.

## Layout

| Path | What |
|---|---|
| `app/` | Electron main, supervisor, LAN server, protocol, renderers |
| `sidecar/` | Python sidecar — Zone SDK wrapper, line engine, sim source |
| `tokens.css`, `lib/`, `ipad/`, `_ds/`, `tv-*.html`, `card/profile/email.html` | Claude Design output (visual source of truth) |
| `assets/fonts/` | Locally bundled fonts (no CDN) |
| `build/` | PyInstaller spec/script, webroot staging, electron-builder resources |
| `docs/` | Architecture + build docs |
| `.claude/agents/` | The seven specialized subagents |

## Build phases

Worked in order, each with a verification gate (see the master prompt). **Phase 0
(scaffold + prove the build) is complete**; Phase 1 (real data on the wire) is next.
