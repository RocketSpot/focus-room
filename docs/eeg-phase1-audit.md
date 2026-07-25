# Phase 1 Audit — EEG Data Lineage (source of truth)

Status: **approved 2026-07-25** as the basis for the staged rebuild.
Method: read-only trace of every displayed value back to the packet source, plus one live payload captured off the WS wire. No code was changed during the audit.

This document is the authoritative record. Sections marked **CONFIRMED** are facts read
directly from code or the wire. Sections marked **ASSUMPTION** are values the code
depends on but that are not verified against Zone hardware. Sections marked **UNRESOLVED**
require Zone/firmware answers (see `eeg-hardware-confirmations.md`).

---

## Central finding

**The application does not receive per-channel EEG at the earbud's native rate.** It
receives only ~1 Hz derived scalars. Raw per-channel ADC is decoded *inside* the vendor
SDK and published on a callback (`on_raw_data`) that `zone_source.py` never subscribed to,
so it never crossed the sidecar process boundary and never reached the browser.

Two regimes:

- **Simulation** (`--simulate`): five bands are algebraic functions of one synthetic
  engagement scalar — not independent, not spectral.
- **Real hardware**: five bands *are* independently integrated from a genuine Welch PSD,
  **but computed on a single channel-averaged signal**, forwarded as **relative shares
  only**, at ~1 Hz. Raw never leaves the SDK.

Phase 2A plumbs the already-available raw stream to the browser and corrects immediate
truthfulness issues. STATUS 2026-07-25: **Phase 2A code implementation complete; real-
hardware validation PENDING** (no Zone earbuds paired — see docs/eeg-phase2a1-notes.md). It does **not** rebuild the spectral pipeline, focus model, or reads.

---

## Data lineage (CONFIRMED)

```
Zone bud BLE ─► connection.py _process_packet:527  (24-bit signed ADC counts, 2 ch/bud)
             ─► _channel_buffers[0..3]  = [Left-A, Left-B, Right-A, Right-B]  (floats, ADC counts)
zone.py _stream_loop:1100
   read_data(50) ─► _emit_raw(RawEEGData)      ◄── on_raw_data NOT subscribed by zone_source (pre-2A)
   every 500 samp (2 s), hop 250 (1 s):
     processors.SignalProcessor.process_streaming:781
       ADC→µV (0.0224 µV/ct) → detrend+bandpass 0.5–40 + notch 50/60/100/120
       → artifact remove (+linear interp up to 30%) → np.mean(4 ch)=1 ch :611
       → Welch PSD Hann 2 s → Simpson per band → RELATIVE share (spec["relative"]) :847
     CognitiveMetrics.compute:677  focus=engagement=β/(α+θ), norm to [0.3,2.5]→0-100
zone_source _on_brainwaves:626 / _on_metrics:609  ─► engine.feed(m.engagement):130 (6 s trailing mean)
   ─► NDJSON eeg/frame · eeg/brainwaves · eeg/metrics · eeg/connection · fit/*
room-core SURFACE_FORWARD:40  ─► WS :4321 ─► tv-signal.html (5 lanes) · tv-reveal.html · reads.js
```

## Message contract (CONFIRMED, `sidecar/protocol.py`)

Server→sidecar: `eeg/frame` `{engagementRel, stateWord, signalQuality, tRel, t}`,
`eeg/brainwaves` `{delta,theta,alpha,beta,gamma,engIndex,t}`, `eeg/metrics`,
`eeg/connection`, `eeg/stats`, `fit/impedance`, `fit/battery`, `session/plateau`, `session/dip`,
`session/samples`, `session/archetype`.

**Example payload captured live (`--simulate`, this machine):**
```json
{"type":"eeg/connection","leftConnected":true,"rightConnected":true,"dropRateL":0,"dropRateR":0,"batteryL":88,"batteryR":91,"t":1784996575693}
{"type":"eeg/frame","engagementRel":0.04,"stateWord":"settling","signalQuality":0.97,"tRel":0,"t":1784996575694}
{"type":"eeg/brainwaves","delta":0.6151,"theta":0.8011,"alpha":1.1619,"beta":0.8132,"gamma":0.3283,"engIndex":0.4143,"t":1784996575694}
```
No message carries `channels`, `raw`, `adc`, or µV fields.

## Per-series findings (CONFIRMED unless noted)

| Property | one line (`eeg/frame`) | 5 bands (`eeg/brainwaves`) | metrics |
|---|---|---|---|
| source | SDK `engagement` (real) / synth `e` (sim) | Welch relative shares (real) / `_bands(e)` (sim) | β/(α+θ) on relative bands |
| kind | derived metric | **relative band share** | derived ratio |
| rate | ~1 Hz | ~1 Hz | ~1 Hz |
| window/hop | 6 s / 1 s | **2 s / 1 s, 50 % overlap** (`zone.py:78-79`) | 2 s / 1 s |
| spectral | none | **Welch, Hann, Simpson** (`processors.py:605-651`) | none |
| band edges | — | δ.5–4 θ4–8 α8–13 β13–30 γ30–45 (`processors.py:77-82`) | — |
| channel agg | — | **mean of 4 ch pre-PSD** (`processors.py:611`) | — |
| smoothing | 6 s trailing (causal) | reveal centered ~10 s (`tv-reveal.html:230`) / reads.js centered 9 s (`reads.js:241`) — **non-causal** | EMA α=0.3 causal |
| normalization | adaptive lo/hi | per-moment share; reveal re-shares | (v−0.3)/2.2×100 clip |
| units | dimensionless | dimensionless share | 0–1 |

- **tv-signal "signal is clear" 5 lines** (`tv-signal.html:160-233`): ~1 Hz band shares placed
  in fixed lanes (δ0.20…γ0.85), ±0.24 swing, monotone-cubic **spline** (`lib/focusline.js:154`).
  Not a waveform; not 250 Hz; not raw.
- **signalQuality** (`zone_source.py:632-645`): `min(rate/250 × (1−drop))` — **connection/packet
  quality, not EEG cleanliness.** Sim: fixed 0.97.
- **Artifact handling** (`processors.py:509-586`): amplitude/gradient/flatline/zscore, then
  **linear interpolation up to 30 %** of the window; above 30 % it returns anyway and still
  computes bands. No omission path.

## Filter config drift (CONFIRMED)

`CONFIG.filter` bandpass is **0.5–40 Hz** (`processors.py:51-52`) while comments and the reveal
imply "1–45 Hz". Gamma band is 30–45 Hz but everything above 40 Hz is attenuated. Recorded as
DSP tech-debt for the canonical phase.

## Notification timing (CONFIRMED)

`interruptEegT = eegTimeOf(Date.now())` at the orchestrator fire call
(`orchestrator.js:937`, `eegTimeOf:175`), mapped through `streamEpoch = frame.t − tRel·1000`
where `frame.t = int(time.time()*1000)` at sidecar **emit** time. Represents the **JavaScript
call**, not OS/audio/audible onset. No sample-accurate alignment; no firmware marker.

## ASSUMPTIONS (depended on, unverified)

- ADC→µV: `vref=4.5, gain=24, 24-bit` → **0.02235 µV/count** (`processors.py:37,110-119`).
- Sample rate 250 Hz hardcoded in three places (`connection.py:69`, `processors.py:42`, `zone.py:78`).
- Channel names `["Left-A","Left-B","Right-A","Right-B"]` (`processors.py:43`) — provisional; no montage.
- "focus" typical range `[0.3, 2.5]` (`processors.py:98`) — arbitrary normalization.

## UNRESOLVED (require Zone answers)

See `eeg-hardware-confirmations.md`. Blocking for: µV labels, anatomical labels, new bipolar
derivations, per-ear band claims, sample-accurate notification cost, authoritative focus claims.
Not blocking for: the raw live display (raw samples are already available in-process).

## Raw availability (CONFIRMED — the actionable finding)

`on_raw_data`/`_emit_raw` deliver `RawEEGData(timestamp, channels=[[Left-A],[Left-B],[Right-A],[Right-B]],
sample_rate)` — **ADC counts as floats**, ~50 samples/batch, ~5 batches/s — every chunk
(`zone.py:1111,1480`). `zone_source.py` did not subscribe. The µV scale factor exists; the
per-channel live-display filter `VisualizationFilter` (`processors.py:264-484`) is written but
**dead code, referenced nowhere**, and unvalidated. Getting raw 250 Hz per-channel EEG to the
app needs a callback subscription + a batched message, **not** a hardware change.
