"""Zone, The Focus Room: the stateful side of band analysis.

Owns everything spectral.py deliberately does not: per-channel ring buffers,
window scheduling, session-scoped artifact references, the accept/drop decision,
the fit-failure ladder, and the counters that let the orchestrator judge a
session's data quality honestly.

TWO THINGS THIS FIXES STRUCTURALLY
----------------------------------
1. A rejected window can no longer drop the band row while still feeding the
   engagement metric. The old code omitted high-delta windows in _on_brainwaves
   but had no guard at all in _on_metrics, so a window rejected as "movement"
   still drove the focus line and the diagnostic. Here one accepted window
   produces one result, and both outputs come from it or neither does.

2. Artifact thresholds are SESSION-SCOPED, not window-scoped. The SDK's stage
   compared each window against its own 99.5th percentile, which flags roughly a
   fixed fraction of samples whether the window is pristine or is one continuous
   artifact. References here are medians over recent ACCEPTED windows, so a bad
   window is measured against what good ones looked like.

Never interpolates. There is no gap-filling path in this file, and the test
suite asserts that by inspection.
"""

from __future__ import annotations

from collections import deque

import numpy as np
from scipy import signal as _sig

import spectral as S
from eeg_stream import (
    ADC_MAX, ADC_MIN, CLIP_MARGIN_COUNTS, CLIP_FRACTION_BAD,
    FLATLINE_MAD_COUNTS, LINE_RATIO_BAD, _goertzel_mag,
)

WINDOW_SEC = 6.0
HOP_SEC = 1.0

# --- artifact thresholds, all relative to the session's own references -------
FLATLINE_REL = 0.20        # amplitude below this fraction of reference ⇒ dead contact
BLOWUP_REL = 3.5           # measured-band amplitude above this multiple ⇒ clench
STEP_REL = 10.0            # a single jump this many times the robust gradient ⇒ pop
DRIFT_REL = 12.0           # slow-component travel this many times the REFERENCE amplitude
DRIFT_SELF_REL = 20.0      # ...or this many times the window's OWN amplitude, which needs
                           # no reference and so still fires on the very first window
DRIFT_PROBE_HZ = 1.5       # the slow component drift is measured on, below the analysis band
EDGE_GUARD_SEC = 0.5       # discarded each end of the window for the artifact tests only
REF_WINDOWS = 60           # accepted windows contributing to the running references
CHI_WINDOWS = 30           # accepted windows contributing to the running exponent
MIN_ACCEPTED_CHANNELS = 2  # below this a window is degraded (1) or dropped (0)
MIN_REF_WINDOWS = 3        # references are provisional until this many accepted


def _robust_amp(x):
    """1.4826 * MAD about zero, in ADC counts. Robust to a few outliers."""
    if len(x) == 0:
        return 0.0
    return float(1.4826 * np.median(np.abs(x)))


class BandAnalyzer:
    """Accumulates raw ADC counts and emits one measured result per accepted window.

    Callback receives a dict with `osc` (dB above this guest's own 1/f floor),
    `share` (the correct half-open total-power share, for legacy surfaces only),
    `aperiodic`, `quality` and `engagement`.
    """

    def __init__(self, fs=250.0, window_sec=WINDOW_SEC, hop_sec=HOP_SEC,
                 n_channels=4, log=None):
        self.fs = float(fs)
        self.window_n = int(round(window_sec * self.fs))
        self.hop_n = int(round(hop_sec * self.fs))
        self.window_sec = float(window_sec)
        self.hop_sec = float(hop_sec)
        self.n_channels = int(n_channels)
        self.log = log or (lambda *_a, **_k: None)
        self._cb = None
        # cached filter designs: the slow component drift is judged on, and the
        # measured band the amplitude and step criteria are judged on
        self._slow_sos = _sig.butter(2, DRIFT_PROBE_HZ, btype="low", fs=self.fs, output="sos")
        self._meas_sos = _sig.butter(4, [S.ANALYSIS_LO_HZ, S.ANALYSIS_HI_HZ],
                                     btype="band", fs=self.fs, output="sos")
        self._edge = int(round(EDGE_GUARD_SEC * self.fs))
        self._buf = [deque(maxlen=self.window_n) for _ in range(self.n_channels)]
        # canonical slot labels; ingest maps arriving labels onto these
        self._labels = ["Left-A", "Left-B", "Right-A", "Right-B"][: self.n_channels]
        self._since_hop = 0
        # session-scoped references, seeded from accepted windows
        self._amp_ref = [deque(maxlen=REF_WINDOWS) for _ in range(self.n_channels)]
        self._grad_ref = [deque(maxlen=REF_WINDOWS) for _ in range(self.n_channels)]
        self._chi_hist = deque(maxlen=CHI_WINDOWS)
        # counters, reported to the orchestrator so data quality is judged on facts
        self.windows_accepted = 0
        self.windows_dropped = 0
        self.drop_reasons = {}

    def on_window(self, cb):
        self._cb = cb

    def reset(self, keep_references=True):
        """Between beats. References are kept by default so the detector is warm
        at t=0 of the reading, having learned the guest during the signal check."""
        for b in self._buf:
            b.clear()
        self._since_hop = 0
        self._chi_hist.clear()
        if not keep_references:
            for d in self._amp_ref:
                d.clear()
            for d in self._grad_ref:
                d.clear()
        self.windows_accepted = 0
        self.windows_dropped = 0
        self.drop_reasons = {}

    # ---------------- ingest ----------------
    def ingest(self, cols, labels=None):
        """cols: per-channel sample lists, as zone_source._on_raw receives.

        Channels are placed by LABEL into fixed slots (Left-A, Left-B, Right-A,
        Right-B), never by position. The raw callback hands over two columns
        when a single bud streams, and positionally those landed in slots 0
        and 1 regardless of which ear they came from, so a right-bud-only
        stretch was screened against the LEFT ear's amplitude references and
        rejected wholesale. On the first hardware day, with buds dropping in
        and out, single-bud stretches were the norm, not the edge case.
        """
        if not cols:
            return
        n = 0
        slots = None
        if labels:
            idx = {lab: k for k, lab in enumerate(self._labels)}
            got = [idx.get(lab) for lab in labels[: self.n_channels]]
            if all(g is not None for g in got):
                slots = got
        for j, col in enumerate(cols[: self.n_channels]):
            if col is None:
                continue
            slot = slots[j] if slots is not None and j < len(slots) else j
            self._buf[slot].extend(float(v) for v in col)
            n = max(n, len(col))
        self._since_hop += n
        # schedule on the FULLEST buffer, not slot 0: with correct label mapping a
        # right-bud-only stream fills slots 2 and 3, and keying on slot 0 would
        # mean a single right bud never produced a window at all
        while self._since_hop >= self.hop_n and max(len(b) for b in self._buf) >= self.window_n:
            self._since_hop -= self.hop_n
            self._emit_window()
    def _screen(self, i, raw):
        """Decide whether ONE channel's window is usable. Returns (ok, reason, filt).

        TWO SIGNALS ARE DERIVED, DELIBERATELY:

          `filt` is the 0.5-90 Hz analysis signal handed on to the PSD.
          `meas` is band-limited to the range actually measured, 2-45 Hz, and is
          what the amplitude and step criteria judge.

        Judging amplitude on the wider signal was rejecting good windows: drift
        sits at around 1 Hz, so it inflates the robust amplitude of `filt` and
        trips the blow-up test even when the measured band is perfectly clean.
        Measured on natural head movement, delta stayed within 0.6 dB of zero in
        windows that were being thrown away for a blow-up that existed only
        below the analysis band. Guests are meant to be able to move.

        Drift keeps its own criterion, judged on the RAW signal before any
        high-pass, because asking a filtered signal about the thing the filter
        just removed is not a test. It uses the peak-to-peak travel of the slow
        component rather than a linear slope, since real contact drift wanders
        rather than ramping.
        """
        if len(raw) < self.window_n // 2:
            return False, "short", None

        # rail contact, on raw counts
        at_rail = np.mean((raw >= ADC_MAX - CLIP_MARGIN_COUNTS) |
                          (raw <= ADC_MIN + CLIP_MARGIN_COUNTS))
        if at_rail > CLIP_FRACTION_BAD:
            return False, "clipping", None

        slow = _sig.sosfiltfilt(self._slow_sos, raw)
        drift_range = float(np.ptp(slow[self._edge:-self._edge]))

        filt = S.analysis_filter(raw, self.fs)
        # Statistics are taken from the INTERIOR of the window. Zero-phase
        # filtering rings at the edges in proportion to the low-frequency
        # content it removed, and that ringing was being detected as electrode
        # pops: a smooth 1 Hz drift with no step in it anywhere was producing
        # 'step' rejections purely from filter transients. Half a second either
        # side is discarded for the artifact tests. The PSD keeps the full
        # window, where Welch's Hann taper already suppresses the same effect.
        meas = _sig.sosfiltfilt(self._meas_sos, filt)[self._edge:-self._edge]
        amp = _robust_amp(meas)
        dmeas = np.diff(meas)
        grad = _robust_amp(dmeas)

        if amp < FLATLINE_MAD_COUNTS:
            return False, "flatline", None

        amp_ref = float(np.median(self._amp_ref[i])) if len(self._amp_ref[i]) >= MIN_REF_WINDOWS else None
        grad_ref = float(np.median(self._grad_ref[i])) if len(self._grad_ref[i]) >= MIN_REF_WINDOWS else None

        # Self-referential first, because every other relative test needs a
        # reference built from accepted windows, and at a cold start there is
        # none. Without this, the opening windows of a session where the buds
        # were never seated properly sail through unchecked: measured, three of
        # the first thirty windows of a violently drifting recording were being
        # accepted purely because the detector had not warmed up yet.
        if drift_range > DRIFT_SELF_REL * amp:
            return False, "drift", None

        if amp_ref:
            if amp < FLATLINE_REL * amp_ref:
                return False, "flatline", None
            if amp > BLOWUP_REL * amp_ref:
                return False, "amplitude", None
            if drift_range > DRIFT_REL * amp_ref:
                return False, "drift", None
        if grad_ref and grad > 0:
            peak = float(np.max(np.abs(dmeas)))
            if peak > STEP_REL * grad_ref:
                return False, "step", None

        # mains contamination, measured rather than assumed
        rms = float(np.sqrt(np.mean(meas ** 2))) or 1e-9
        for f0 in S.LINE_HZ:
            if _goertzel_mag(filt, self.fs, f0) / rms > LINE_RATIO_BAD:
                return False, "line", None

        return True, None, filt


    def _note_drop(self, reason):
        self.drop_reasons[reason] = self.drop_reasons.get(reason, 0) + 1

    # ---------------- the window ----------------
    def _emit_window(self):
        raws, kept, rejected, reasons = [], [], [], []
        for i in range(self.n_channels):
            if len(self._buf[i]) < self.window_n:
                rejected.append(self._labels[i] if i < len(self._labels) else f"ch{i}")
                reasons.append("short")
                continue
            raw = np.asarray(self._buf[i], dtype=np.float64)
            ok, why, filt = self._screen(i, raw)
            if ok:
                kept.append((i, filt))
                raws.append(raw)
            else:
                rejected.append(self._labels[i] if i < len(self._labels) else f"ch{i}")
                reasons.append(why)

        if not kept:
            self.windows_dropped += 1
            self._note_drop(reasons[0] if reasons else "no-channel")
            return

        chi_prior = float(np.median(self._chi_hist)) if self._chi_hist else None
        stack = np.vstack([f for _i, f in kept])
        # prefiltered: _screen already ran analysis_filter on each channel, and
        # applying the band-pass and both notches a second time would double the
        # effective filter order for no gain
        res = S.analyse_window(stack, fs=self.fs, chi_prior=chi_prior, prefiltered=True)

        if not res["ok"]:
            # rung three: no usable fit and no prior exponent. Drop the window
            # rather than fall back to relative shares, which would silently
            # reintroduce the very bug this pipeline exists to remove.
            self.windows_dropped += 1
            self._note_drop("fit")
            return

        # only accepted windows update the references, so a bad window can never
        # raise the bar for the good ones that follow
        for i, filt in kept:
            meas = _sig.sosfiltfilt(self._meas_sos, filt)[self._edge:-self._edge]
            self._amp_ref[i].append(_robust_amp(meas))
            self._grad_ref[i].append(_robust_amp(np.diff(meas)))
        if res["aperiodic"]["mode"] == "fit":
            self._chi_hist.append(res["aperiodic"]["exponent"])

        self.windows_accepted += 1
        osc = res["osc"]
        result = {
            "osc": osc,
            "share": res["share"],
            "powers": res["powers"],
            "aperiodic": res["aperiodic"],
            "engagement": self.engagement_from(osc),
            "quality": {
                "channelsUsed": len(kept),
                "channelsRejected": rejected,
                "windowSec": self.window_sec,
                "hopSec": self.hop_sec,
                "degraded": len(kept) < MIN_ACCEPTED_CHANNELS,
            },
        }
        if self._cb:
            self._cb(result)

    # ---------------- engagement ----------------
    @staticmethod
    def engagement_from(osc):
        """beta against alpha and theta, in the log domain.

            EI = OSC_beta - 0.5 * (OSC_alpha + OSC_theta)      [dB]

        which is beta / sqrt(alpha * theta) in power. Computed on oscillatory
        prominence rather than raw band power, so the 1/f background cancels out
        of it too. The 0..1 mapping is DISPLAY SCALING ONLY; engine.py applies
        its own per-session relative scale on top, exactly as before.
        """
        ei = osc.get("beta", 0.0) - 0.5 * (osc.get("alpha", 0.0) + osc.get("theta", 0.0))
        return float(min(1.0, max(0.0, 0.5 + ei / 12.0)))

    # ---------------- reporting ----------------
    def counters(self):
        total = self.windows_accepted + self.windows_dropped
        return {
            "windowsAccepted": self.windows_accepted,
            "windowsDropped": self.windows_dropped,
            "acceptedFraction": (self.windows_accepted / total) if total else 0.0,
            "dropReasons": dict(self.drop_reasons),
            "exponentMedian": float(np.median(self._chi_hist)) if self._chi_hist else None,
        }
