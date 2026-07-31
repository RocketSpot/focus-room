# Repository map — how to read this history

Everything is preserved: the original source as received, the audited baseline, and
every change since, with the reasoning in the commit messages and in `docs/`.

## Branches

| Branch | What it is |
|---|---|
| `original-source` | **The pristine Focus Room source as delivered**, before any work. Its own root commit, so anything can be diffed against exactly what was received. |
| `main` | The Phase 1 baseline — the working room as audited, before the live-raw-EEG work began. Not moved since. |
| `phase-2a-live-raw-eeg` | All subsequent work. **Not merged to `main`**: the branch carries EEG changes that are pending real-hardware validation. |

## Tags (frozen — do not move or recreate)

| Tag | Commit | Meaning |
|---|---|---|
| `v0-original-source` | root of `original-source` | The starting point. |
| `phase-2a.2-approved` | `2012288` | Pre-validation corrections, approved: eligibility state machine, multimodal event timing, staff-gated engineering view, local validation recorder. |
| `phase-2a.2-prehardware-secure` | `55499f9` | Raw-EEG WebSocket routing requires launcher-issued authorization; packaged deployment also requires loopback. |
| `phase-2a.2-hardware-ready` | `bbdc4f9` | Credential containment: the raw-stream token never reaches page JavaScript. **Run the hardware validation from this tag.** |

## Key documents

- `docs/eeg-phase1-audit.md` — the data-lineage audit: what the app actually received, traced to the packet source.
- `docs/eeg-hardware-confirmations.md` — confirmed vs unresolved hardware facts; the interruption medium.
- `docs/eeg-phase2a1-notes.md` — sample-rate/continuity terminology, quality window, display-filter spec, routing/retention.
- `docs/eeg-phase2a2-notes.md` — the three pre-validation corrections, validation mode, and the WebSocket authorization work.
- `tests/eeg-hardware-validation.md` — the real-hardware protocol and its 24-criterion acceptance table (**still pending**).

## Status

Real-hardware validation has **not** been run — it needs Zone earbuds and a consenting
participant. Until it passes, `phase-2a-live-raw-eeg` is not approved for production merge.

## Not in this repository (by design)

- `node_modules/`, `venv/` — reinstall (`npm ci`; `pip install -r requirements.txt`). Electron
  and the Python EEG stack are platform-specific.
- `data/` — guest session records (typed thoughts, emails). Private; never committed.
- `.env` / `config.local.json` — secrets. Never committed.
- `assets/fonts/files/PPNeueMontreal-*.woff2` — licensed font, deliberately untracked.
- `validation-captures/` — raw ADC engineering captures stay local to the machine that recorded them.
