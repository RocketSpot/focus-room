# Phase 2A.1 — validation & cleanup notes

Status: **Phase 2A code implementation complete. Real-hardware validation PENDING** (no
Zone earbuds were paired). This document records the corrected schemas, the display-filter
spec, the quality method, channel selection, raw-data routing, the interruption medium, and
the real-hardware validation plan. Simulation establishes that transport + renderer work with
controlled inputs; it does NOT establish correct display of real Zone EEG.

---

## 1. Sample-rate terminology (item 3)

There is **no device sample counter and no per-sample timestamp** on the SDK `on_raw_data`
callback (Phase 1 audit). Therefore callback-arrival timing measures **ingest throughput**,
never the physical ADC sampling frequency. Fields (`eeg/config-v1`, `eeg/raw-v1`,
`eeg/quality-v1`):

| Field | Meaning |
|---|---|
| `expectedHardwareSampleRateHz` | 250 — config expectation, **not** measured |
| `sdkReportedSampleRateHz` | `RawEEGData.sample_rate` (a config claim from the SDK) |
| `deviceMeasuredSampleRateHz` | **null** — cannot be measured without a device counter |
| `deviceSampleRateMeasurementAvailable` | **false** |
| `callbackCadenceHz` | measured callbacks/sec (EMA) |
| `meanSamplesPerCallback` | measured samples/callback (EMA) |
| `ingestThroughputSamplesPerSecond` | total samples ÷ elapsed monotonic time |
| `throughputMeasurementWindowSeconds` | elapsed monotonic window used |
| `sampleRateTimingMethod` | `"callback_arrival_throughput_only"` |
| `sampleRateConfidence` | `"unverified"` |

**Reconciling the earlier "252 samples/s vs 245 Hz":** both were the SAME quantity
(ingest throughput) computed two ways, and NEITHER is the hardware rate.
- 5.0 batches/s × ~50 samples/batch ≈ **252 samples/s** — cumulative count ÷ elapsed.
- **245 Hz** was the per-callback EMA of samples ÷ inter-callback Δt, which under-reads
  because the sim's 0.2 s asyncio loop has scheduling slack (each "0.2 s" tick is slightly
  longer), so samples-per-second measured between callbacks is a touch under 250.
Both are **throughput**, labelled as such; the device rate stays `null`. Measured throughput
over 10 s / 60 s / 5 min is reported by the perf harness (§Performance).

## 2. Continuity & packet-loss (item 4)

No device sequence number exists, so the app **cannot prove firmware/radio packet loss,
duplication, or reordering**. Continuity is split by layer:

- **Device continuity** — `deviceContinuityAvailable:false`, `deviceSampleCounter:null`,
  `devicePacketSequence:null`. Unverifiable here.
- **SDK-callback continuity** — `sdkCallbackGapEstimate` (bool) + `estimatedMissingSamples`,
  **inferred from monotonic timing only** (`continuityMethod:"callback_timing_inference"`,
  `continuityConfidence:"low"`). An inferred callback delay is **not** a confirmed packet loss.
- **Browser-transport continuity** — the browser tracks `browserTransportSequence`, and
  drops a duplicate / out-of-order batch into an explicit `droppedDisplayBatches` counter
  (a display/transport drop, **never** called device packet loss).

**What each test can detect:** flatline/clipping/step/drift/line-noise on the received
samples; an *inferred* callback gap from a timing jump; a browser-side duplicate/reorder.
**What it cannot:** firmware- or radio-level loss, silent duplication inside the SDK, or the
true per-sample timing. The engineering view shows: *"Device sample continuity unverified —
firmware exposes no sample counter."*

## 3. Quality window & inputs (item 6)

- **Window:** accumulated rolling **6 s** (`QUALITY_WINDOW_SEC`); **hop 0.33 s**
  (`QUALITY_HOP_SEC`). Chosen so drift (needs several seconds) and 50/60 Hz line detection
  (needs ≥300 cycles for a stable Goertzel) are not judged from a single ~50-sample callback.
  Provisional.
- **Per metric, all over the 6 s window on RAW ADC COUNTS** (never the browser's display-
  filtered copy): flatline (robust MAD < 12 counts), clipping (>2% within 256 counts of a
  rail), electrode-step (max |Δ| > 12× robust-derivative-MAD), robust amplitude (1.4826·MAD),
  drift (0.5 s moving-mean range > 6× robust amplitude), line-noise (Goertzel 50/60 Hz ÷
  broadband RMS > 0.5), usablePct (fraction of recent windows fully clean).
- **Backend quality never uses browser display filtering.** The browser's causal biquad is a
  presentation filter only; quality runs in Python on the immutable ADC counts.

## 4. Channel selection & hysteresis (item 7)

Per ear, choose one of {A,B} by an explicit policy, recorded with reason + confidence:
- keep the current channel unless it has been **ineligible for `SWITCH_HOLD`=3 consecutive
  assessments (~1 s)** — a single noisy window can't flap A↔B;
- switch to a replacement only once it has been **eligible for 3 consecutive assessments**;
- `selectedConsumerChannels` carries `left/right`, `switched`, `reason`, `confidence`,
  `switchAtIndex`.
- In the renderer, a switch **breaks the trace** at `switchAtIndex` and draws an amber dashed
  marker — a channel change never reads as a biological transition; a new segment starts after.
Tested: no flapping under intermittent noise, sustained-failure switch with reason, no A↔B
oscillation, recovery, and the visible break.

## 5. Real-mode clear-state gate (item 5)

All thresholds are provisional (unvalidated on real recordings), so the final **"Signal is
clear" state is gated OFF in real mode** (`clearStateEnabled:false`, `qualityThresholdStatus:
"provisional"`). Real-mode states: `receiving` → `received` (both ears delivering usable
channels) → `limited` (one ear) → `poor`. Only deterministic **simulation** (known-clean
injected signal) may reach `clear`. The orchestrator fit-gate accepts `received` OR `clear`,
so real guests still advance; only the validated wording is withheld. Enable with
`FOCUSROOM_CLEAR_STATE=1` once thresholds are approved.

## 6. Live display filter — full spec (item 12)

- **Family:** RBJ cookbook biquads, **2 sections** in series: high-pass then low-pass.
- **Order:** 2 per section (biquad); **each section Q = 0.707** (Butterworth-ish).
- **High-pass:** 1.0 Hz. **Low-pass:** 40.0 Hz. `fs` = `expectedHardwareSampleRateHz`.
- **Form / state:** Transposed Direct Form II, **per-channel persistent state** (`z1,z2`),
  so successive ~50-sample batches filter continuously (no per-chunk restart).
- **Causal** — never `filtfilt`, never centered. **Reset** on a gap ≥ `resetGapSamples`
  (125 ≈ 0.5 s) so it doesn't ring across a hole; also reset on channel-count/config change.
- **Startup transient:** the LP state is primed to the first sample to minimise the DC step;
  a short (<~0.3 s) warm-up transient remains and is **not** suppressed (no samples hidden).
- **NaN:** propagates as NaN (a gap), never a fabricated finite value.
- **Measured response** (fs 250):

  | Hz | 0.2 | 0.5 | 1 | 2 | 5 | 10 | 20 | 30 | 40 | 45 | 50 | 60 |
  |----|-----|-----|---|---|---|----|----|----|----|----|----|----|
  | gain | 0.04 | 0.24 | 0.71 | 0.97 | 1.00 | 1.00 | 0.98 | 0.89 | 0.71 | 0.60 | 0.50 | 0.32 |
  | phase delay (ms) | — | — | −245 | −55 | −4 | 3 | 5 | 6 | 6 | 6 | 6 | 6 |

  Group delay is **frequency-dependent** (≈5–6 ms in the passband, phase lead below ~5 Hz
  from the high-pass) — a single fixed latency is **not** claimed.
- **Provisional / tech-debt:** the passband is 1–40 Hz while band nomenclature elsewhere
  cites gamma 30–45 Hz — this 40-vs-45 inconsistency is logged for the canonical DSP phase.
- **Raw is never overwritten** — the filter output is display-only; ADC counts are kept.

## 7. Raw-data routing & retention (item 11)

- **Who receives `eeg/raw-v1`:** the **TV role only** (which hosts `tv-signal.html` + its
  engineering view). Config + quality (small, TV-relevant) also ride the TV role. The
  orchestrator reads quality in-process (not via broadcast) for the fit gate.
- **Not sent to:** iPad controller, reveal, email/profile/card renderers, analytics,
  generic logs, browser console, localStorage/sessionStorage, third-party monitoring.
- **Retention:** raw is **ephemeral** — a fixed-size browser ring buffer (6000 samples/ch,
  bounded memory) and a rolling 6 s Python quality buffer. **Not persisted** to the session
  record, **not logged**, **not sent to analytics**. Cleared on session reset and on the
  `idle`/`welcome` beat (`resetScope` zeroes every ring). A fresh `EegStream` per session and
  `resetScope` on the browser guarantee **sim and real buffers can never mix**.
- The ops diagnostic feed mirrors messages only when an operator console is open (authorised
  engineering diagnostics), and nothing is written to disk.

## 8. Interruption medium (item 14)

The interruption is **two simultaneous app-side events, NOT earbud audio**:
1. a **visual notification card on the iPad** (React card in `screens2.jsx`, shown on
   `interruption/fire`), and
2. a **room-audio duck** on the hidden audio host (`room-audio.html`).

Timing captured (`orchestrator.interruptionTiming`, folded into the session record + reveal):
- `eventRequestTime` — the orchestrator's fire call (master clock ms).
- `eventRenderedTime` — the iPad's **actual rendered-frame time** of the card, reported back
  via `notification_shown` (double-rAF ≈ committed paint); upgrades `timingMethod` to
  `ipad_render_report`.
- `estimatedPhysicalOnset` — null (not yet measured).
- `timingUncertaintyMs` — 1200 (fire-only) → 400 (render report); `timingConfidence` low.
- `media` — `["ipad_visual_card","room_audio_duck"]`.
No firmware onset marker exists; **no sample-accurate alignment is claimed.** The audio-duck
scheduled time and a loopback calibration to the guest's actual perception are future work.

## 9. Real-hardware validation plan (item 8 — PENDING, no earbuds)

When Zone buds are available, run `tests/eeg-hardware-validation.md` (harness/checklist):
record ≥5 min continuous + a 60–120 s extract of all four raw channels; annotate still /
blink / swallow / jaw-clench / head-turn / reseat / L-out / L-in / R-out / R-in / disconnect /
reconnect / quiet recovery (**annotations, not a validated classifier**). Validate: real
callback structure, channel order, cadence, samples/callback, SDK-reported rate, ingest
throughput, all four channels changing **independently** (no silent averaging), display
scaling, filter startup, disconnect/reconnect, one-ear `limited`, channel hysteresis, render
stability, and **no invented data through real gaps**. Deliver: real L/R + 4-channel + one-ear
+ gap screenshots; raw `eeg/config-v1`/`eeg/raw-v1`/`eeg/quality-v1` examples; a short raw
extract; the 5-min log; and every warning/anomaly. **Until then Phase 2A stays hardware-
validation-pending and this branch is not merged to production.**
