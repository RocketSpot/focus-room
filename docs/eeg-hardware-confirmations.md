# EEG Hardware Confirmations

Companion to `eeg-phase1-audit.md`. Separates **CONFIRMED** hardware facts from
**UNRESOLVED** questions. Code, metadata, diagnostics, and copy must respect this
separation. Physical-electrode count and transmitted-channel count are **different
concepts** and must never be conflated.

---

## CONFIRMED (topology, 2026-07-25)

- `physicalElectrodeCount`: **8** (total, both earbuds)
- `physicalElectrodesPerEar`: **4**
- `sensingElectrodesPerEar`: **2** (positive / sensing)
- `referenceElectrodesPerEar`: **2** (reference)
- `transmittedEegChannelCount`: **4** (currently transmitted EEG values, total)
- `channelsPerEar`: **2**
- Current technically-accurate description:
  **"8 in-ear electrodes producing 4 differential EEG channels."**
- Current software channel labels (provisional): `Left-A`, `Left-B`, `Right-A`, `Right-B`
- Exact electrode→channel mapping: **provisional** (`channelMappingStatus: "provisional"`)

> Do **not** describe the system as having 8 independently transmitted EEG channels
> unless the firmware packet format later proves 8 independent differential signals are
> sampled and transmitted. It is 8 electrodes → 4 channels today.

### Confirmed in code (Phase 1 audit)

- The SDK receives **two signed 24-bit EEG values per earbud** (`connection.py:_process_packet`),
  decoded into `_channel_buffers[0..3]` as ADC counts (floats).
- Raw batches are already emitted via `on_raw_data` / `_emit_raw` (`zone.py:1111,1480`).

---

## UNRESOLVED (require Zone / firmware / schematic answers)

For each: **[code] / [ui] / [analysis] / [claim]** = area affected;
**2A?** = whether Phase 2A can proceed without the answer.

1. Which positive + reference electrode produce **Left-A**? [analysis][claim] — **2A: yes** (labels stay provisional)
2. Which produce **Left-B**? [analysis][claim] — 2A: yes
3. Which produce **Right-A**? [analysis][claim] — 2A: yes
4. Which produce **Right-B**? [analysis][claim] — 2A: yes
5. Are the two reference electrodes per bud **electrically independent**? [analysis] — 2A: yes
6. Are the two references **joined** anywhere in the circuit? [analysis] — 2A: yes
7. Schematic **net names** for all 8 physical contacts? [analysis][claim] — 2A: yes
8. Which **ADS1299 input pins** map to each transmitted value? [code][analysis] — 2A: yes
9. Verified **ADS1299 sample-rate register** setting? [code][analysis] — 2A: yes (we measure observed rate)
10. **Observed** sample rate in a real recording? [code][analysis] — **2A: measured, reported as observedSampleRateHz**
11. Verified **Vref and PGA gain**? [analysis][claim] — **2A: blocks µV labels** (we show relative amplitude)
12. Exact **ADC-count→µV** formula? [analysis][claim] — 2A: blocks µV labels
13. Are incoming values **ADC counts or already converted**? [code] — **2A: CONFIRMED = ADC counts (floats)** via `_process_packet`; still worth Zone confirmation
14. Which HW/FW **high-pass, low-pass, notch, bias, reference** settings are enabled? [analysis][claim] — 2A: yes (display filter is provisional)
15. Are both buds sampled from **one shared clock**? [code][analysis] — 2A: yes (we don't cross-correlate ears)
16. If separate clocks, how are streams **synchronized**? [code][analysis] — 2A: yes
17. Does the packet contain a **sequence number**? [code] — **2A: CONFIRMED absent in RawEEGData; we synthesize a local continuity index**
18. Does the packet contain a **device sample counter**? [code] — **2A: CONFIRMED absent in RawEEGData; local index used** (connection.py tracks per-packet `sample_num` internally but it is not surfaced on `on_raw_data`)
19. How are dropped/duplicate/out-of-order packets **represented**? [code] — 2A: we estimate gaps from monotonic timing + sample counts
20. How is **impedance** measured? [analysis][claim] — 2A: yes (existing fit path unchanged)
21. Validated **impedance thresholds** for good/usable/poor? [analysis][claim] — 2A: yes (thresholds provisional)
22. Is **synchronized IMU** data available? [analysis] — 2A: yes (motion artifact deferred)
23. What **physical medium** produces the interruption (screen / computer audio / tablet audio / earbud audio)? [analysis][claim] — **2A: instrument the app-side event; do not assume earbud audio**
24. What timestamp is closest to the **guest's actual perception** of the interruption? [analysis][claim] — 2A: capture request + rendered/scheduled time; sample-accurate deferred

---

## Blocking policy

**Blocked until answered:** microvolt scale labels (Q11–12), anatomical channel labels
(Q1–7), new bipolar derivations (Q1–7), per-ear band-power claims (Q1–7, Q15–16),
absolute amplitude comparisons (Q11–12), sample-accurate notification-cost claims (Q23–24),
scientifically authoritative focus claims.

**Not blocked (proceeds in 2A):** the raw live L/R + 4-channel display, continuity/gap
detection via local index, per-channel relative-amplitude quality, honest status copy,
event-timing instrumentation of the app-side event, terminology corrections, and the
temporary reveal safety patch.
