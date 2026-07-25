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

- unlock only in a **dev/staff build** (the launcher's preload reports `staffUiEnabled=true`) via
  `?staff=1`/`?dev=1`, or on any build via a **locally configured credential**
  (`FOCUSROOM_STAFF_TOKEN`, entered with `S`). There is **no hardcoded PIN** and `?pin=` is not read
  (see the pre-merge hardening section below — a production guest build ships locked);
- `E` toggles the view **only** when staff mode is unlocked; ordinary guests get nothing; and the
  `window.__scope` test hooks exist **only** in a dev/staff build, never in a production guest page;
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

## Pre-merge operational hardening (done — small config changes, no scope expansion)

Completed on top of the frozen approved point (tag `phase-2a.2-approved` = `2012288`); these are
configuration/access-control changes only — no DSP, visualization, focus-model, or post-session
methodology was touched.

1. **No hardcoded staff PIN.** The old page-side default (`2468`) is gone. The staff credential is
   **locally configured** (`FOCUSROOM_STAFF_TOKEN`) and handed to the page by the launcher via the
   preload (`app/main.js` `staffConfigArg()` → `app/preload.js` `window.__FOCUSROOM__.staff`). Empty
   credential ⇒ the PIN unlock is disabled entirely.
2. **`?staff=1` / `?dev=1` disabled in production guest builds.** The preload reports
   `staffUiEnabled` = `config.isDev` — **false in a packaged production build** — and `tv-signal.html`
   activates the bare params only when `STAFF_UI` is true. A plain browser hitting the LAN surface
   (no launcher/preload) gets the locked default. In dev, the launcher appends `?staff=1` to the
   signal surface so staff still get the engineering view.
3. **Validation directory hardened.** Default is a **local, access-restricted (`0700`), non-synced**
   per-user app-data dir (`…/zone-focus-room/validation-captures`) — never the repo, cwd, Documents,
   Desktop, iCloud, Dropbox, or OneDrive; `FOCUSROOM_VALIDATION_DIR` overrides. `validation-captures/`
   is git-ignored (defense-in-depth). Metadata carries an explicit **retention/deletion policy**
   (retain only for the review, then delete).
4. **No participant identifiers.** Capture filenames use a **fixed non-identifying label** (`sim` /
   `real` / `session` only); a name-like label is dropped. Metadata carries
   `containsParticipantIdentifiers: false` and no name/email/guest-id fields.

Tests: `tests/eeg-display.test.js` (no hardcoded PIN; launcher-gated activation; guest-build params
inert; launcher-issued credential unlocks; `window.__scope` hooks dev/staff-only) and
`tests/eeg-validation-recorder.test.py` (app-data non-synced default dir; `0700` dir + `0600` files;
label whitelist; annotation-kind whitelist + note dropped; retention policy; no identifiers).

An adversarial verification pass (`workflows/verify-2a2-hardening`) found and we FIXED, in-scope:
the `window.__scope.setStaff()/pressE()` bypass (now dev/staff-only), the un-whitelisted annotation
`kind`/`note` (now a fixed vocabulary, note dropped), `0644→0600` capture files, and a stale `2468`
reference in this doc.

## Finding #5 — RESOLVED: WS raw-stream now requires launcher-token authorization (+ loopback)

**The finding** (from the verification pass; pre-existing, not introduced by 2A/2A.2): `app/server.js`
took the socket role verbatim from the client `client/hello` with no authentication, and raw
`eeg/raw-v1`/`eeg/config-v1`/`eeg/quality-v1` were broadcast to the `tv` role — so a LAN guest could
`hello` as `role:"tv"` and receive the raw four-channel stream directly. Reproduced live (1 raw frame
to an unauthenticated `tv` socket on the old path), defeating acceptance criterion 20.

**The fix** (transport/authorization only — no DSP/methodology touched): raw messages are delivered
ONLY to sockets the **server** authenticated for the `eeg-raw` capability; the client-declared role is
never trusted for raw. In packaged production, an authorized socket must **also** be loopback.

**Authorization handshake (server-verified):**
```json
{ "type": "client/hello", "role": "tv", "capabilities": ["eeg-raw"],
  "rawStreamToken": "<ephemeral launcher token>", "clientTime": 0 }
```
Server sets a **server-owned** authorization on that socket (never a client field):
```json
{ "authenticated": true, "role": "tv", "rawEeg": true,
  "source": "launcher-token", "authenticatedAtMonotonicMs": 0.0 }
```
Raw routing (`server.broadcastRaw` / `server.sendRawTo`, `app/room-core.js`) consults **only**
`socket.authorization.rawEeg === true`. Evaluated ONCE, on the first hello; a later message can
never upgrade an unauthenticated socket; a role change never grants raw.

**Token lifecycle:** a **256-bit** `crypto.randomBytes(32)` token, generated **once per launcher
process** (`app/main.js`) and **rotated every restart**. **Distinct from `FOCUSROOM_STAFF_TOKEN`.**
Passed to the server in-process (`server.configureRawAuth`) and to the authorized TV renderer via the
preload's private `additionalArguments` channel; the preload exposes it **only through a function**
(`window.__FOCUSROOM__.rawStreamToken()`), never a readable string. It travels only inside the WS
hello frame — **never** a URL, query param, `localStorage`/`sessionStorage`, console, application log,
capture file, or the iPad. Disconnect drops the socket's authorization; reconnect re-authenticates;
a previous-launcher token is rejected.

**Loopback (packaged):** `requireLoopback = config.isPackaged`. Accepts `127.0.0.1`, `::1`,
`::ffff:127.0.0.1` from the socket's actual `remoteAddress` (never `X-Forwarded-For`, a client IP, or
a JS-declared location). A separate-device TV is **not** approved this phase; it would need explicit
secure pairing + encrypted transport.

**Fail-closed:** no server token, no supplied token, invalid token, non-loopback (packaged), or a
rotated-away token ⇒ **no raw**. Failed attempts emit a minimal event (remote category + count only —
no token, no reason, no samples), are rate-limited, and the socket is closed after repeats. No raw is
buffered for a not-yet-authenticated socket. The `ops` diagnostic feed no longer carries raw types.
The headless `web-main.js` configures no token ⇒ raw stays closed to remote browsers (correct).

**Raw-routing matrix (by client, after the fix):**

| Client | receives eeg/config-v1, raw-v1, quality-v1? |
|---|---|
| Guest browser, no token | **no** |
| Guest/LAN client claiming `role:"tv"`, no/invalid token | **no** |
| Non-loopback client with a valid token (packaged) | **no** |
| Browser with staff UI but no raw authorization | **no** |
| iPad controller / reveal / audio / ops | **no** |
| Authorized local TV socket (token + loopback), consumer mode | **yes** — min raw for the L/R waveform |
| Authorized local TV socket, staff mode | **yes** — plus the client-side 4-channel engineering view |

Engineering-view visibility (staff mode) and raw-stream authorization are **independent**: both must
hold before four-channel engineering data is displayed; staff mode is never the network credential.

Tests: `tests/eeg-raw-auth.test.js` (30 checks — live WS routing + loopback/rotation/rate-limit/
fail-closed). Manual before/after exploit reproduction confirmed the old path leaked and the new path
does not, with the authorized TV waveform preserved and the iPad unaffected.

**Status: RESOLVED in code + tests. Real-hardware validation still pending; branch still not merged.**

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
