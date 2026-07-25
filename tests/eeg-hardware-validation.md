# Phase 2A.2 real-hardware validation — protocol + acceptance checklist

Status: **NOT YET RUN — no Zone earbuds paired.** This protocol requires **connected Zone
earbuds and a human operator** wearing/manipulating them; it cannot be executed by an automated
agent. **Do not use simulation data as evidence for this phase.** Until every acceptance criterion
below passes, Phase 2A stays hardware-validation-pending and `phase-2a-live-raw-eeg` must not merge.

## 0. Setup + pre-flight

1. Launch real + validation mode:
   `FOCUSROOM_VALIDATION=1 FOCUSROOM_VALIDATION_DIR=./validation-captures npm run dev:real`
   Confirm `/__info` → `simulate:false`.
2. Pair Zone buds; ops console → **Find earbuds → Connect**.
3. Open `/tv-signal.html?staff=1` on the TV (staff mode for the engineering view); press **E**.
4. **Pre-flight confirmations** (record each): real mode active · SIMULATED badge absent · both
   buds connected · `physicalElectrodeCount==8` · `transmittedEegChannelCount==4` · channel labels
   remain provisional · raw values labelled ADC counts / unverified SDK units · no µV scale · engineering
   mode staff-protected · no raw EEG on the iPad controller.

## 1. Marked sequence (≥8 continuous minutes, all four channels)

Mark every event via the ops console (`mark <kind>`), which annotates the local capture.
**These are engineering annotations for signal inspection, NOT cognitive findings.**

- **A. Initial stability** — 60 s still, reading normally. Mark start/end.
- **B. Eye/face** — 5 ordinary blinks (spaced) · 1 sustained eye closure · 3 swallows · 3 brief jaw
  clenches. Mark each.
- **C. Head/ear** — head left→center→right→center · look down→center · touch left bud · touch right
  bud. Mark each.
- **D. Left-ear failure/recovery** — remove/disengage left bud · hold ≥10 s · reinsert · wait for
  recovery. Confirm: only the left-ear group goes unavailable/abnormal · right display continues ·
  **no invented line bridges the interval** · consumer status → `limited` · filter state resets.
  Mark removal + reinsertion.
- **E. Right-ear failure/recovery** — repeat for the right ear. Mark removal + reinsertion.
- **F. Channel-selection** — briefly disturb one channel/contact on an ear (without fully removing).
  Confirm hysteresis prevents rapid A/B switching · any real switch creates a segment break + amber
  marker · selected channel + reason recorded.
- **G. Interruption** — read ≥30 s, trigger the normal interruption **once**. Record: visual request
  time · iPad rendered-frame time · audio-duck request time · audio-clock scheduled time · sidecar
  receipt times. **Do NOT compute/present an interruption-cost result** — this validates instrumentation only.
- **H. Connection interruption** — one controlled Bluetooth/app disconnect, held long enough to be
  recognised, then reconnect. Confirm: a real display gap · no bridging line · filter reset · ring
  buffers do not mix pre/post data · no simulated data appears · queues stay bounded.
- **I. Final stability** — another 60 s still reading. Confirm the system stays stable.

## 2. Acceptance criteria — PASS/FAIL table (operator fills during the run)

| # | Criterion | Pass/Fail | Evidence / note |
|---|---|---|---|
| 1 | Four actual raw channels received from connected Zone buds | ☐ | |
| 2 | Channel order stable during normal operation + reconnect | ☐ | |
| 3 | No pre-display averaging combines the four channels | ☐ | |
| 4 | Consumer view shows one actual eligible channel per ear | ☐ | |
| 5 | Engineering view shows all four actual channels | ☐ | |
| 6 | Left-ear failure affects the left group; no fabricated left trace | ☐ | |
| 7 | Right-ear failure affects the right group; no fabricated right trace | ☐ | |
| 8 | Missing data creates a true visual gap | ☐ | |
| 9 | Flatline vs missing represented as separate conditions | ☐ | |
| 10 | Channel switching stable, documented, visibly segmented | ☐ | |
| 11 | The app cannot auto-advance from packet receipt alone | ☐ | |
| 12 | Staff override disables EEG interpretation | ☐ | |
| 13 | Raw samples remain ADC counts / unverified SDK units | ☐ | |
| 14 | No µV scale displayed | ☐ | |
| 15 | No anatomical montage claimed | ☐ | |
| 16 | Signal-screen waveform geometry uses only raw EEG samples | ☐ | |
| 17 | No spline / generated noise produces EEG-looking detail | ☐ | |
| 18 | Foreground performance stable for the full run | ☐ | |
| 19 | Queues + buffers remain bounded | ☐ | |
| 20 | Raw EEG reaches only the authorized signal + engineering surfaces | ☐ | |
| 21 | Event markers recorded separately for visual + audio | ☐ | |
| 22 | No notification-effect interpretation shown to guests | ☐ | |
| 23 | No Phase 2B code added | ☐ | |
| 24 | Every failure/anomaly reported, not cosmetically hidden | ☐ | |

**If any criterion fails, leave Phase 2A marked incomplete and attach a correction plan.**

## 3. Hardware-stream report (record from the actual buds)

on_raw_data object shape · #channels · channel order · values/channel/callback · callback-size
distribution · `sdkReportedSampleRateHz` · callback-cadence distribution · ingest throughput over
10 s / 60 s / full run · do batch sizes vary · do callbacks pause/bunch · any duplicated samples ·
any SDK-reported internal drops · all four channels vary independently · left removal → left group ·
right removal → right group · labels swapped? · reconnect changes order? · reconnect restarts local
indices correctly? · device continuity still unavailable? · any value unexpectedly µV-calibrated?
**Do not infer electrode pairing from waveform appearance; do not change provisional labels without
schematic/firmware confirmation.**

## 4. Eligibility-state transition log

Record every transition for: `transportReady`, `displayEligible`, `analysisEligible`,
`revealEligible`, `overallStatus`, selected consumer channels, `staffOverride`, `reasons`. Verify:
normal packets set transportReady · transport readiness alone cannot set analysisEligible · one
usable ear cannot set analysisEligible · gross flatline/clipping prevents analysisEligible · a
grossly-usable channel on each ear is required · no auto-advance from transportReady alone · a staff
override is explicit + visible + disables reveal eligibility · insufficient usable-data coverage
disables reveal eligibility · no guest EEG claim when revealEligible is false. **Label any pass
"provisional analysis eligibility" — not scientifically validated signal quality.**

## 5. Foreground performance (visible TV surface, full run)

mean fps · 1st-pct fps · max frame time · browser main-thread CPU · browser memory start/end ·
sidecar CPU · sidecar memory · EEG callbacks received · EEG samples received · raw batches forwarded ·
raw batches intentionally dropped for display (`droppedDisplayBatches`) · browser-transport dups ·
browser-transport reordering · max queue depth · render frames dropped · end-to-end
callback→visible-display latency · disconnect recovery time · reconnect recovery time. Confirm: ring
buffers bounded · queue growth bounded · memory does not grow continuously · **slow rendering does
not become reported device packet loss** · display drops counted separately · raw acquisition not
blocked by rendering.

## 6. Filter validation on the real signal

Filter state separate per channel · continuous across ordinary chunks · long gap triggers the
documented reset · channel switching creates a fresh segment + appropriate filter handling · startup
transient not presented as meaningful EEG · raw ADC data unchanged · display-filtered data not used
by backend quality · not used for post-session numbers · frequency-dependent delay documented · no
sample-accurate event claim from the display trace. **Include the full filter-response table +
coefficients** (see `docs/eeg-phase2a1-notes.md` §6).

## 7. Raw-data privacy + routing check (during the real run)

Verify `eeg/raw-v1` is NOT delivered to: iPad controller · reveal · email · profile · card ·
analytics · console logs · generic app logs · localStorage · sessionStorage · third-party error
monitoring. Confirm: engineering capture occurred only because validation mode was explicitly
enabled · validation files remain local · buffers clear at session end + on disconnect · raw capture
closes cleanly on app exit · real + simulated buffers cannot mix · engineering mode can be fully
disabled for guest operation.

## 8. Required screenshots

1 normal real L/R consumer · 2 all four real engineering channels · 3 left-ear unavailable ·
4 right-ear unavailable · 5 a true transport/disconnect gap · 6 a received flatline/grossly-unusable
channel (if reproducible) · 7 a channel-switch marker · 8 reconnected signal after filter reset ·
9 the staff-only engineering-mode indicator · 10 the real-mode "Signal received" state.

## 9. Deliver

The 24-criterion table (filled) · the hardware-stream report · the eligibility transition log · the
perf results · the filter-response table + coefficients · the routing/privacy verification · all 10
screenshots · the local raw extract + `.meta.json` + `.log.txt` from the validation recorder · every
anomaly · remaining hardware questions · an explicit **merge / do-not-merge** recommendation ·
confirmation no Phase 2B work began.
