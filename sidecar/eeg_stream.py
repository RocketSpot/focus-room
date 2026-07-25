"""Phase 2A / 2A.1 — raw EEG batch transport + honest signal quality (one source of truth).

Consumes raw per-channel ADC-count batches (real: SDK ``on_raw_data``; sim: a labelled
synthetic generator) and produces three versioned messages: ``eeg/config-v1`` (once per
stream), ``eeg/raw-v1`` (per batch) and ``eeg/quality-v1`` (throttled).

DISCIPLINE
  * Raw ADC counts are the IMMUTABLE source. No overwriting / filtering / interpolation /
    channel averaging here. Display filtering happens causally in the browser.
  * No microvolts. Amplitudes are reported in ADC COUNTS, never labelled µV (calibration
    unverified — see docs/eeg-hardware-confirmations.md).
  * The SDK stream exposes NO device sample counter, NO per-sample timestamp, and NO packet
    sequence number (verified in the Phase 1 audit). Therefore:
      - device-level continuity is UNVERIFIABLE here (deviceContinuityAvailable=false);
      - the physical ADC sample rate is UNVERIFIED — callback-arrival timing measures INGEST
        THROUGHPUT, not the hardware sampling frequency (deviceMeasuredSampleRateHz=null);
      - a "gap" is an INFERRED sdk-callback gap from monotonic timing, not a proven radio/
        firmware packet loss.
  * All thresholds are PROVISIONAL (unvalidated on real Zone recordings). Until validated,
    real mode must NOT show the final "clear" state (clearStateEnabled=false); only
    deterministic simulation, whose injected signal is known clean, may reach 'clear'.

Quality is computed on RAW ADC COUNTS over an accumulated ROLLING window (not one ~50-sample
callback), updated on a shorter hop. Pure stdlib so it runs in any sidecar and is unit-testable.
"""

import math
import os
import statistics
import time
from collections import deque

# --- ADC geometry (24-bit signed) — only used for clip/flatline in COUNTS, never µV ---
ADC_BITS = 24
ADC_MAX = 2 ** (ADC_BITS - 1) - 1        # +8388607
ADC_MIN = -(2 ** (ADC_BITS - 1))         # -8388608
CLIP_MARGIN_COUNTS = 256

# --- quality window / hop (item 6) -------------------------------------------------
# A single ~50-sample (0.2 s) callback is far too short to judge drift or 50/60 Hz
# line contamination, so every metric is computed over an accumulated ROLLING window
# and refreshed on a shorter hop. 6 s chosen: long enough for a few cycles of the
# slowest drift we care about and >=300 cycles of 50/60 Hz for a stable line probe,
# short enough that a reseat is reflected within ~a window. PROVISIONAL.
QUALITY_WINDOW_SEC = 6.0
QUALITY_HOP_SEC = 0.33                    # emit/refresh cadence (~3 Hz)

# --- provisional thresholds (relative/robust; no absolute µV) ----------------------
FLATLINE_MAD_COUNTS = 12.0                # robust spread below this ⇒ flatline/dead contact
CLIP_FRACTION_BAD = 0.02                  # >2% of window at a rail ⇒ clipping
STEP_MAD_MULT = 12.0                      # a jump > this×(robust deriv) ⇒ electrode step
DRIFT_RANGE_MULT = 6.0                    # slow-mean range > this×(robust amp) ⇒ heavy drift
LINE_RATIO_BAD = 0.5                      # 50/60 Hz magnitude / broadband RMS above this ⇒ line-contaminated
USABLE_MIN_FRACTION = 0.6                 # recent clean fraction a channel needs to be "usable"
CLEAR_SUSTAIN_SEC = 2.0                   # both ears usable this long ⇒ 'clear' (sim only until validated)
RATE_MISMATCH_TOL = 0.15                  # |ingest−expected|/expected above this ⇒ mismatch flag
GAP_TOLERANCE_SAMPLES = 8                 # inferred-missing below this is ignored as jitter
# hysteresis (item 7): consecutive assessments a condition must hold before it acts
SWITCH_HOLD = 3                           # ~1 s at the 0.33 s hop

CONFIG_SCHEMA_VERSION = 1
RAW_SCHEMA_VERSION = 1
QUALITY_SCHEMA_VERSION = 1


def _mad(xs):
    if len(xs) < 2:
        return 0.0
    med = statistics.median(xs)
    return statistics.median([abs(x - med) for x in xs])


def _goertzel_mag(samples, fs, freq):
    """Single-bin Goertzel magnitude at ``freq`` — a cheap line-noise probe (no full FFT)."""
    n = len(samples)
    if n < 8 or fs <= 0:
        return 0.0
    k = int(0.5 + (n * freq) / fs)
    w = (2.0 * math.pi / n) * k
    coeff = 2.0 * math.cos(w)
    s_prev = s_prev2 = 0.0
    for x in samples:
        s = x + coeff * s_prev - s_prev2
        s_prev2 = s_prev
        s_prev = s
    power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2
    return math.sqrt(max(0.0, power)) / n


class _ChannelQuality:
    """Rolling per-channel quality from RAW ADC counts (never display-filtered). Robust stats.

    Window: ~QUALITY_WINDOW_SEC of raw samples. flatline/clip/step/robust-amplitude/drift/
    line-noise are all computed over this accumulated window; usablePct is the fraction of
    recent windows that were fully clean."""

    def __init__(self, fs):
        self.fs = fs
        self.buf = deque(maxlen=int(QUALITY_WINDOW_SEC * fs) + 16)
        self._clean_hist = deque(maxlen=64)

    def add(self, samples):
        for x in samples:
            self.buf.append(float(x))

    def assess(self, present):
        if not present:
            self._clean_hist.append(False)
            return {"present": False, "eligible": False, "reasons": ["absent"], "inputDomain": "raw_adc_counts"}
        xs = list(self.buf)
        if len(xs) < max(16, int(0.25 * self.fs)):
            self._clean_hist.append(False)
            return {"present": True, "eligible": False, "reasons": ["filling"], "inputDomain": "raw_adc_counts"}

        med = statistics.median(xs)
        amp_counts = 1.4826 * _mad(xs)
        flatline = amp_counts < FLATLINE_MAD_COUNTS
        clip_frac = sum(1 for x in xs
                        if x >= ADC_MAX - CLIP_MARGIN_COUNTS or x <= ADC_MIN + CLIP_MARGIN_COUNTS) / len(xs)
        clipping = clip_frac > CLIP_FRACTION_BAD

        diffs = [abs(xs[i] - xs[i - 1]) for i in range(1, len(xs))]
        deriv_mad = _mad(diffs) if diffs else 0.0
        step = bool(diffs) and max(diffs) > STEP_MAD_MULT * max(deriv_mad, 1.0)

        w = max(2, int(0.5 * self.fs))
        means = [sum(xs[i:i + w]) / w for i in range(0, len(xs) - w, w)]
        drift = bool(means) and (max(means) - min(means)) > DRIFT_RANGE_MULT * max(amp_counts, 1.0)

        rms = math.sqrt(sum((x - med) ** 2 for x in xs) / len(xs)) or 1e-9
        line_ratio = max(_goertzel_mag(xs, self.fs, 50.0), _goertzel_mag(xs, self.fs, 60.0)) / rms
        line = line_ratio > LINE_RATIO_BAD

        reasons = []
        if flatline: reasons.append("flatline")
        if clipping: reasons.append("clipping")
        if step: reasons.append("electrode_step")
        if drift: reasons.append("drift")
        if line: reasons.append("line_noise")

        clean = not reasons
        self._clean_hist.append(clean)
        usable_pct = (sum(1 for c in self._clean_hist if c) / len(self._clean_hist)) if self._clean_hist else 0.0
        eligible = clean and usable_pct >= USABLE_MIN_FRACTION

        return {
            "present": True, "eligible": bool(eligible),
            "inputDomain": "raw_adc_counts",       # quality is NOT computed on display-filtered data
            "windowSec": QUALITY_WINDOW_SEC, "windowSamples": len(xs),
            "flatline": bool(flatline), "clipping": bool(clipping), "clipFraction": round(clip_frac, 4),
            "electrodeStep": bool(step), "drift": bool(drift),
            "lineNoise": bool(line), "lineRatio": round(line_ratio, 3),
            "robustAmplitudeCounts": round(amp_counts, 1),   # COUNTS, never µV
            "usablePct": round(usable_pct, 3), "reasons": reasons,
        }


class EegStream:
    """Per-session raw transport + quality. One instance per streaming session (real or sim)."""

    def __init__(self, tx, log, simulation, expected_rate_hz=250):
        self.tx = tx
        self.log = log
        self.simulation = bool(simulation)
        self.expected_rate = expected_rate_hz
        # Real mode must NOT reach the final "clear" state until thresholds are validated on
        # real recordings. Only deterministic simulation (known-clean) may — or an explicit
        # override once validation lands.
        self.clear_state_enabled = self.simulation or os.environ.get("FOCUSROOM_CLEAR_STATE") == "1"
        self.seq = 0
        self.local_index = 0                 # LOCAL continuity index (no device counter exists)
        self.total_samples = 0
        self.callback_count = 0
        self._t0 = None
        self._last_recv = None
        self._cadence_hz = None              # EMA of callbacks/sec
        self._mean_batch = None              # EMA of samples/callback
        self._sdk_rate = None                # raw.sample_rate reported by the SDK (unverified)
        self._q = {}
        self._selected = {"left": None, "right": None}
        self._sel_reason = {"left": "none", "right": "none"}
        self._sel_switch_at = {"left": None, "right": None}   # local index of last switch
        self._ineligible_run = {}            # per label: consecutive ineligible assessments
        self._eligible_run = {}
        self._clear_since = None
        self._config_sent = False
        self._last_quality_emit = 0.0

    # ---- config (emit once per stream) ----
    def emit_config(self, labels, sdk_rate=None):
        if self._config_sent:
            return
        self._config_sent = True
        self._sdk_rate = sdk_rate
        self.tx.send_raw({
            "type": "eeg/config-v1", "schemaVersion": CONFIG_SCHEMA_VERSION,
            "physicalElectrodeCount": 8, "physicalElectrodesPerEar": 4,
            "sensingElectrodesPerEar": 2, "referenceElectrodesPerEar": 2,
            "transmittedEegChannelCount": 4, "channelsPerEar": 2,
            "channelLabels": ["Left-A", "Left-B", "Right-A", "Right-B"],
            "channelMappingStatus": "provisional",
            # sample-rate: hardware value UNVERIFIED; SDK-reported is a config claim, not a
            # measurement; device-level measurement is unavailable (no counter/timestamps).
            "expectedHardwareSampleRateHz": self.expected_rate,
            "sdkReportedSampleRateHz": sdk_rate,
            "deviceMeasuredSampleRateHz": None,
            "deviceSampleRateMeasurementAvailable": False,
            "sampleRateTimingMethod": "callback_arrival_throughput_only",
            "sampleRateConfidence": "unverified",
            "units": "adc_counts_unverified_sdk_units", "calibrationStatus": "unverified",
            "qualityThresholdStatus": "provisional", "clearStateEnabled": self.clear_state_enabled,
            "deviceContinuityAvailable": False,
            "engineeringNote": ("Device-level sample continuity and the physical ADC sample rate "
                                "are UNVERIFIED because the firmware stream exposes no sample "
                                "counter, per-sample timestamps, or packet sequence number. "
                                "Callback-arrival timing measures ingest throughput only."),
            "simulation": self.simulation,
        })

    # ---- per-batch ingest ----
    def ingest(self, channels, labels, now_monotonic=None, sdk_rate=None):
        if now_monotonic is None:
            now_monotonic = time.monotonic()
        if self._t0 is None:
            self._t0 = now_monotonic
        self.emit_config(labels, sdk_rate if sdk_rate is not None else self._sdk_rate)

        n = min((len(c) for c in channels), default=0)
        if n == 0:
            return
        for lab in ["Left-A", "Left-B", "Right-A", "Right-B"]:
            self._q.setdefault(lab, _ChannelQuality(self.expected_rate))
            self._ineligible_run.setdefault(lab, 0)
            self._eligible_run.setdefault(lab, 0)

        present = {lab: (lab in labels) for lab in ["Left-A", "Left-B", "Right-A", "Right-B"]}
        for lab, col in zip(labels, channels):
            self._q[lab].add(col[:n])

        # ---- continuity (item 4): INFERRED sdk-callback gap from monotonic timing ----
        sdk_gap = False
        est_missing = 0
        out_of_order = False
        if self._last_recv is not None:
            dt = now_monotonic - self._last_recv
            if dt < 0:
                out_of_order = True
            else:
                rate = self._cadence_and_throughput_rate()
                expected_samples = dt * rate
                missing = expected_samples - n
                if missing > GAP_TOLERANCE_SAMPLES:
                    sdk_gap = True
                    est_missing = int(round(missing))
                self.local_index += max(0, est_missing)   # advance across the gap, never close it
            # cadence + mean-batch EMAs
            inst_cad = 1.0 / max(1e-6, now_monotonic - self._last_recv)
            self._cadence_hz = inst_cad if self._cadence_hz is None else 0.85 * self._cadence_hz + 0.15 * inst_cad
        self._mean_batch = float(n) if self._mean_batch is None else 0.9 * self._mean_batch + 0.1 * n
        self._last_recv = now_monotonic
        self.callback_count += 1
        self.total_samples += n

        first_index = self.local_index
        self.local_index += n
        last_index = self.local_index - 1
        self.seq += 1

        by_label = {lab: col[:n] for lab, col in zip(labels, channels)}
        samples = [[round(v, 1) for v in by_label.get(lab, [])] if present[lab] else None
                   for lab in ["Left-A", "Left-B", "Right-A", "Right-B"]]

        self.tx.send_raw({
            "type": "eeg/raw-v1", "schemaVersion": RAW_SCHEMA_VERSION,
            "sequenceNumber": self.seq, "firstSampleIndex": first_index,
            "lastSampleIndex": last_index, "sampleCount": n,
            "expectedHardwareSampleRateHz": self.expected_rate,
            "sdkReportedSampleRateHz": self._sdk_rate,
            "ingestThroughputSamplesPerSecond": round(self._throughput(), 1),
            "sourceTimestamp": None,             # no per-sample device time exists
            "monotonicReceiveTimestamp": round(now_monotonic - self._t0, 6),
            "channelLabels": ["Left-A", "Left-B", "Right-A", "Right-B"],
            "samples": samples,                  # ADC counts; null channel = absent ear
            "continuity": {
                "deviceContinuityAvailable": False,
                "deviceSampleCounter": None, "devicePacketSequence": None,
                "sdkCallbackGapEstimate": sdk_gap, "estimatedMissingSamples": est_missing,
                "browserTransportSequence": self.seq,   # the browser re-checks dup/reorder
                "browserTransportDuplicateDetected": False,
                "browserTransportOutOfOrderDetected": out_of_order,
                "continuityMethod": "callback_timing_inference",
                "continuityConfidence": "low",
            },
            "simulation": self.simulation,
        })

        if (now_monotonic - self._last_quality_emit) >= QUALITY_HOP_SEC:
            self._last_quality_emit = now_monotonic
            self.tx.send_raw(self._quality_message(present, now_monotonic))

    # ---- throughput / cadence ----
    def _throughput(self):
        if self._t0 is None:
            return 0.0
        el = max(1e-6, (self._last_recv or self._t0) - self._t0)
        return self.total_samples / el

    def _cadence_and_throughput_rate(self):
        # for the gap estimate use the measured per-channel ingest throughput when we have
        # enough history, else fall back to the expected hardware rate (documented).
        thr = self._throughput()
        return thr if self.callback_count > 10 and thr > 0 else self.expected_rate

    # ---- channel selection with hysteresis (item 7) ----
    def _select(self, ear, a, b, chans):
        cur = self._selected[ear]
        ca, cb = chans[a], chans[b]

        # track eligibility runs for the hysteresis
        for lab, q in ((a, ca), (b, cb)):
            if q["eligible"]:
                self._eligible_run[lab] += 1; self._ineligible_run[lab] = 0
            else:
                self._ineligible_run[lab] += 1; self._eligible_run[lab] = 0

        # keep the current pick unless it has been INELIGIBLE for SWITCH_HOLD assessments —
        # so a single noisy window can't flap the display between A and B.
        if cur and self._ineligible_run.get(cur, 99) < SWITCH_HOLD and chans[cur]["eligible"] is not False:
            if chans[cur]["eligible"]:
                self._sel_reason[ear] = "held (eligible)"
                return cur, False
        # need a replacement: pick a channel that has been eligible for SWITCH_HOLD assessments
        cand = None
        if self._eligible_run.get(a, 0) >= SWITCH_HOLD:
            cand = a
        elif self._eligible_run.get(b, 0) >= SWITCH_HOLD:
            cand = b
        elif ca["eligible"]:
            cand = a
        elif cb["eligible"]:
            cand = b
        switched = cand is not None and cand != cur
        if cand is None:
            self._sel_reason[ear] = "no usable channel"
            self._selected[ear] = None
            return None, cur is not None
        if switched:
            self._sel_switch_at[ear] = self.local_index
            self._sel_reason[ear] = ("initial pick" if cur is None else "switched: " + cur + " became unusable")
        self._selected[ear] = cand
        return cand, switched

    def _quality_message(self, present, now_monotonic):
        chans = {lab: self._q[lab].assess(present[lab])
                 for lab in ["Left-A", "Left-B", "Right-A", "Right-B"]}
        left, sw_l = self._select("left", "Left-A", "Left-B", chans)
        right, sw_r = self._select("right", "Right-A", "Right-B", chans)

        left_ok, right_ok = left is not None, right is not None
        reasons = []
        thr = self._throughput()
        rate_mismatch = (self.callback_count > 10 and thr > 0
                         and abs(thr - self.expected_rate) / self.expected_rate > RATE_MISMATCH_TOL)
        if rate_mismatch:
            reasons.append("ingest_throughput_mismatch(~%.0f/s vs expected %d Hz)" % (thr, self.expected_rate))

        # status. Real mode is CAPPED below 'clear' until thresholds are validated
        # (clearStateEnabled=false → the highest real-mode state is 'received').
        if left_ok and right_ok:
            if self._clear_since is None:
                self._clear_since = now_monotonic
            sustained = (now_monotonic - self._clear_since) >= CLEAR_SUSTAIN_SEC
            if self.clear_state_enabled:
                status = "clear" if (sustained and not rate_mismatch) else "checking"
                if not sustained:
                    reasons.append("stabilising")
            else:
                status = "received"                 # both ears delivering; final "clear" gated off
                reasons.append("clear_state_disabled_pending_threshold_validation")
        else:
            self._clear_since = None
            if left_ok or right_ok:
                status = "limited"; reasons.append("one_ear_unusable")
            elif any(chans[l]["present"] for l in chans):
                status = "poor"; reasons.append("no_usable_channel")
            else:
                status = "receiving"; reasons.append("no_samples")

        def conf(lab):
            if lab is None:
                return "none"
            up = self._q[lab]._clean_hist if lab in self._q else []
            frac = (sum(1 for c in up if c) / len(up)) if up else 0.0
            return "high" if frac > 0.85 else "medium" if frac > 0.6 else "low"

        return {
            "type": "eeg/quality-v1", "schemaVersion": QUALITY_SCHEMA_VERSION,
            "qualityThresholdStatus": "provisional", "clearStateEnabled": self.clear_state_enabled,
            "connectionQuality": {
                "callbackCadenceHz": round(self._cadence_hz, 2) if self._cadence_hz else None,
                "meanSamplesPerCallback": round(self._mean_batch, 1) if self._mean_batch else None,
                "ingestThroughputSamplesPerSecond": round(thr, 1),
                "throughputMeasurementWindowSeconds": round((self._last_recv - self._t0), 1) if self._t0 else 0,
                "expectedHardwareSampleRateHz": self.expected_rate,
                "sdkReportedSampleRateHz": self._sdk_rate,
                "deviceMeasuredSampleRateHz": None, "deviceSampleRateMeasurementAvailable": False,
                "sampleRateConfidence": "unverified",
            },
            "packetContinuity": {
                "deviceContinuityAvailable": False, "continuityMethod": "callback_timing_inference",
                "continuityConfidence": "low", "localIndex": self.local_index, "sequenceNumber": self.seq,
            },
            "channels": chans,
            "selectedConsumerChannels": {
                "left": left, "right": right, "switched": {"left": sw_l, "right": sw_r},
                "reason": {"left": self._sel_reason["left"], "right": self._sel_reason["right"]},
                "confidence": {"left": conf(left), "right": conf(right)},
                "switchAtIndex": {"left": self._sel_switch_at["left"], "right": self._sel_switch_at["right"]},
            },
            "overallStatus": status, "reasons": reasons, "simulation": self.simulation,
        }
