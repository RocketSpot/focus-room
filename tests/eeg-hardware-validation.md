# Real-hardware validation checklist (Phase 2A.1 — RUN WHEN ZONE BUDS ARE AVAILABLE)

Status: **NOT YET RUN — no Zone earbuds paired.** Until this passes, Phase 2A is
hardware-validation-pending and the `phase-2a-live-raw-eeg` branch must not merge to
production.

## Setup
1. Launch real mode: `open "The Focus Room.app"` (or `npm run dev:real`). Confirm
   `/__info` → `simulate:false`.
2. Pair Zone buds; on the ops console tap **Find earbuds → Connect**.
3. Open `/tv-signal.html` on the TV; press **E** for the engineering view.

## Capture (all raw from the SDK boundary)
- Record **≥5 continuous minutes**; save the sidecar log.
- Save a **60–120 s extract** of all four raw channels + every timestamp available at the
  SDK boundary (a WS capture of `eeg/raw-v1`, or dump `RawEEGData` in `_on_raw`).
- Annotate marked periods (these are **test annotations, NOT a validated classifier**):
  still · blink · swallow · jaw-clench · head-turn · earbud-adjust · L-out · L-in · R-out ·
  R-in · brief disconnect · reconnect · quiet recovery.

## Validate (record pass/fail + notes for each)
- [ ] actual `on_raw_data` callback structure matches `RawEEGData(timestamp, channels[], sample_rate)`
- [ ] actual channel order (which array is which physical channel) — update the hardware doc
- [ ] callback cadence (Hz) and mean samples/callback
- [ ] `sdkReportedSampleRateHz` value; ingest throughput over 10 s / 60 s / 5 min
- [ ] all four channels change **independently** (an event on one is not mirrored on others)
- [ ] no silent channel averaging (compare the 4 engineering traces)
- [ ] real display scaling (robust gain sits the trace mid-panel, no pumping)
- [ ] filter startup transient bounded (<~0.3 s), not mistaken for EEG
- [ ] disconnect: trace breaks / status drops, no invented data
- [ ] reconnect: filter resets, stream resumes, status recovers
- [ ] one-ear removed → `limited` state + that ear shown unavailable (no fake trace)
- [ ] channel-selection hysteresis: no rapid A↔B flapping; a real failure switches with a
      visible amber break
- [ ] browser render stability over 5 min (fps, memory bounded, `droppedDisplayBatches`)
- [ ] **no invented data through actual gaps** (packet drop → visible break, never a line)

## Deliver
- Screenshots: real L/R consumer · all four real channels · one-ear `limited` · a real
  disconnect/gap · selected channels.
- Raw `eeg/config-v1`, `eeg/raw-v1`, `eeg/quality-v1` examples.
- The 60–120 s raw extract; the 5-min log; every warning/anomaly.
- Any correction needed to `docs/eeg-hardware-confirmations.md` (channel mapping, observed
  rate, calibration) once the schematic answers arrive.
