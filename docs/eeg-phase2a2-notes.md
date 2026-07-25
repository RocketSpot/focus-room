# Phase 2A.2 — pre-validation corrections + validation infrastructure

Status: **the three pre-validation corrections are code-complete and unit-tested. The
real-hardware validation run (sections 4–12 of the approval) is BLOCKED — no Zone earbuds are
paired to this machine, and the physical protocol requires a human operator wearing and
manipulating the buds.** No simulation data is presented as hardware evidence. The branch
`phase-2a-live-raw-eeg` is **not merged**.

This document records the three corrections, the validation-mode recorder, and the honest
hardware-blocked status. It complements `eeg-phase2a1-notes.md` and `eeg-hardware-confirmations.md`.

---

## Correction 1 — eligibility separated from signal receipt

Receiving raw callbacks is **not** sufficient to advance the room. `eeg/quality-v1` now carries
an explicit eligibility object (`sidecar/eeg_stream.py::_eligibility`):

```json
{ "transportReady": bool, "displayEligible": bool, "analysisEligible": bool,
  "revealEligible": bool, "eligibilityStatus": "checking|provisional-pass|limited|failed",
  "qualityThresholdStatus": "provisional", "staffOverride": false, "reasons": [],
  "ears": { "left": {"selected": "Left-A", "usable": bool}, "right": {…} },
  "usableCoverageFraction": 0.0 }
```

- **transportReady** — callbacks arriving + samples ingested (no sustained stall).
- **displayEligible** — ≥1 channel present, so the consumer scope can draw honestly.
- **analysisEligible** — a **grossly-usable channel on EACH ear** (not flatline, not clipping,
  quality-eligible) **and** delivery sufficiently continuous. This — not transportReady — is
  what unlocks the fit-ready gate (`orchestrator._onEegQuality` → `_fitQualityOk`).
- **revealEligible** — a **higher bar**: analysis-eligible sustained across enough of the
  recording (`REVEAL_MIN_ASSESSMENTS`, `REVEAL_COVERAGE_MIN`). The instant analysis first passes,
  the reveal is NOT yet eligible. The orchestrator makes the FINAL reveal decision (it also knows
  the event pre/post window and staff override).
- **staffOverride** — always `false` at the signal layer; the app overlays a real override.

**UI behaviour** (orchestrator + surfaces): "Checking signal" while evaluating; "Signal received"
when transportReady; **never** "Signal is clear" in real mode; **auto-advance only when
analysisEligible**; a one-ear-usable partial state and a neither-ear "stay on the signal check"
state are carried on `session/state.signal`.

**Staff / demonstration override** (`orchestrator.setStaffOverride`, ops command `staff_override`):
an explicit, visible, staff-only switch. Navigation is unblocked, but the session is marked
`dataQualityStatus: "invalid-for-eeg-interpretation"`, produces **no EEG-derived guest claims**
(`reads.js::noClaimReveal`, `outputs.js` demonstration copy), and is **never labelled measured**.
Visible on every surface via `session/state.staffOverride`.

Tests: `tests/eeg-raw-transport.test.py` (sidecar eligibility, 7 required proofs) and
`tests/eeg-eligibility.test.js` (orchestrator: transport≠advance, staff override allows navigation
but disables reveal claims, revealEligible separate, simulation exempt).

## Correction 2 — multimodal event timing

The interruption is a **visual iPad card + a room-audio duck — not earbud audio**, so a firmware
audio-onset marker is **not relevant** (removed as a requirement). A device EEG **sample counter**
remains desirable for aligning samples, but the firmware exposes none. Markers are captured and
kept **separate**, each in its own clock domain, never collapsed into one "exact" onset, with a
**predeclared** primary marker and a reported uncertainty. Full schema + clock-domain alignment:
see `eeg-hardware-confirmations.md` → "Interruption medium" and `eeg-phase2a1-notes.md` §8.
Instrumentation: `orchestrator._fireInterruption` / `onRoomAudioEvent`, `ipad/controller.jsx`
(visual marker), `room-audio.html::reportAudioDuck` (audio marker). Test: `tests/eeg-event-timing.test.js`.

Guest-facing language is limited to "the notification moment" / "the combined interruption" /
"after the notification appeared and the room audio changed"; it never claims the visual or audio
change independently produced a response.

## Correction 3 — staff-protected engineering view

The engineering view (all four raw channels + detailed quality) is **no longer openable by a stray
`E` keypress**. It is gated behind staff/dev mode (`tv-signal.html`):

- unlock via a **protected URL param set by the launcher/ops** (`?staff=1` or `?dev=1`) or a **local
  staff PIN** (press `S`, enter the PIN; default `2468`, overridable with `?pin=…`);
- `E` toggles the view **only** when staff mode is unlocked; ordinary guests get nothing;
- **staff mode is visibly indicated** (a teal badge, distinct from the amber SIMULATED badge);
- **engineering-view access is logged locally** (`localStorage['focusroom.eng.accessLog']` +
  `console.info`) with **timestamps + action only — never raw samples**;
- **leaving staff mode** (`Escape`) sets `engOn=false`, clears the engineering element, and returns
  to the consumer view; the shared signal rings keep feeding the consumer trace.

Raw EEG still reaches **only** the TV signal surface — never the iPad controller, console logs, or
`localStorage`/`sessionStorage` (confirmed; `sessionStorage` is not used at all). This is an
operational gate for a kiosk TV, **not** a cryptographic control (the PIN lives in the page) —
documented as such. Tests: `tests/eeg-display.test.js` ("engineering-view access control").

## Section 4 — local validation-mode recorder (`sidecar/validation_recorder.py`)

An explicit, **opt-in** engineering recorder for the real-hardware run. **OFF unless
`FOCUSROOM_VALIDATION=1`.** When on, it records to LOCAL files (dir: `FOCUSROOM_VALIDATION_DIR`,
default `./validation-captures/`):

- `<ts>_<label>.raw.ndjson` — `eeg/config-v1` + `eeg/raw-v1` + `eeg/quality-v1`, verbatim. Preserves
  the **original raw ADC counts** (every per-sample value, all four channels) — **not** filtered or
  decimated display data.
- `<ts>_<label>.meta.json` — capture label, counts, staff annotations, no-upload/retention note.
- `<ts>_<label>.log.txt` — a human-readable validation log (config, inferred gaps, annotations, close).

It **never uploads** raw EEG, **does not change production retention** (a separate path), **clearly
labels** the capture as engineering data, and **closes/flushes cleanly** on `stop_session` /
`disconnect` / sidecar shutdown. Staff event annotations (blink, swallow, L-out, disconnect, …) ride
the existing `mark` command (`source.mark` → `EegStream.annotate`); they are inspection marks, **not
a classifier**. Test: `tests/eeg-validation-recorder.test.py` (off by default; records + preserves
the raw ADC spike; labels + no-upload note; clean close).

To run a real capture (when Zone buds are paired):

```
FOCUSROOM_VALIDATION=1 FOCUSROOM_VALIDATION_DIR=./validation-captures npm run dev:real
```

## Hardware-blocked status (honest)

The physical protocol (record ≥8 min; blink/swallow/jaw/head events; L/R ear failure + recovery;
channel-switch; interruption; a controlled disconnect) requires **connected Zone earbuds and a human
operator** wearing/manipulating them. Neither is available to an automated agent, and a Bluetooth
check on this machine shows **no Zone buds paired**. Therefore sections 5–12 (execution, real
screenshots, the populated pass/fail table, the real config/raw/quality examples, the foreground
perf numbers, the eligibility transition log) are **PENDING** and are **not** fabricated or
substituted with simulation. The ready-to-run protocol + acceptance-criteria checklist live in
`tests/eeg-hardware-validation.md`. Until it passes, Phase 2A stays hardware-validation-pending and
`phase-2a-live-raw-eeg` is not merged.
