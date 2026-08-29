"""Zone SDK - electrode impedance estimation.

Faithful port of the desktop app's impedance detector
(see docs/IMPEDANCE_CHECK.md, sections 4.8-4.13 and 6).
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from typing import Optional


# ----- Constants (from docs/IMPEDANCE_CHECK.md section 6) -----

IMPEDANCE_WINDOW_SAMPLES = 256
IMPEDANCE_REFRESH_MS     = 500.0
LOFF_INJECTION_HZ        = 31.25
EEG_SAMPLE_RATE_HZ       = 250
I_INJECT_A               = 24e-9           # ADS1299 lead-off current (24 nA)
R_SERIES_OHM             = 2200.0          # Zone hardware series resistor
LSB_UV_PER_COUNT         = 4.5 / (24.0 * 8388607.0) * 1e6  # ADS1299 uV / count
EMA_ALPHA                = 0.30            # shipping value (2026-08-19 spec): 0.7 prev + 0.3 new
# coverage gate: the 256-sample window is 256 samples of ELAPSED stream time,
# and fewer than half of them present returns None, never a number. None is
# deliberate rather than 0: 0 is below every pass threshold, and "not enough
# data yet" must never read as a perfect contact.
MIN_COVERAGE             = 0.50
# the verdict's one job is telling "worn" apart from "not worn". Provisional,
# from the shipping code; an unworn bud on a desk reads 3.0-3.7 MOhm.
WORN_PASS_OHM            = 2_300_000.0
# PLAUSIBILITY FLOOR (missing-lead guard). If the lead-off command never
# reached the firmware there is no 24 nA tone, and what the DFT measures at
# 31.25 Hz is background noise: readings come out roughly 1000x too low.
# Algebra of that failure: Z' = (Z_true + 2200)/1000 - 2200, so a WORN bud
# maps below zero (below ~2.2 MOhm true; the 2.2-2.3 sliver maps to a positive
# 0-102 Ohm, caught by this floor) but a DESK bud (3.0-3.7 MOhm) maps to
# ~800-1500 Ohm - which without this floor would read as a superb contact.
# A dry in-ear electrode is hundreds of kOhm at best; anything under this
# floor is electrically implausible and must never be trusted, let alone
# pass. Every true impedance below ~12 MOhm maps under the floor in the
# missing-lead mode, so the guard covers the whole realistic range.
MIN_PLAUSIBLE_OHM        = 10_000.0

# kohm thresholds
LOW_Z_MAX   = 50
PAIR_OK_MAX = 150
HIGH_Z_MAX  = 500
QC_GOOD_MAX = 800

# ADS1299 / transport sends ±8388608 when a channel is inactive or data missing.
_ADC_INVALID_ABS = 8_387_000
# NOTE: the old wall-clock-dt "strict/approximate Fs" machinery is gone. The
# position-aware DFT judges the window by TRUE stream positions, so a lossy or
# throttled link costs coverage (a null verdict) instead of a phase-rotated
# amplitude, and true firmware decimation collapses the amplitude into
# no_signal. Both directions fail safe without inferring Fs from wall time.
# TONE SETTLE (arm-side twin of POST_LEADOFF_DISCARD_SEC): the 31.25 Hz tone
# does not step to full amplitude the instant the lead command lands. Samples
# from the first moments of an epoch carry a PARTIAL tone, whose depressed
# amplitude maps to a lower Z - which reads as a BETTER contact - and an EMA
# seeded from them drags through the pass band. Reproduced in review: a 3.3
# MOhm desk bud with a 1.5 s tone ramp read "good" for ~4 s on every arm.
# So the estimator discards everything in the first TONE_SETTLE_SEC of its
# epoch, and the streak starts from full-tone truth.
TONE_SETTLE_SEC = 2.0


def _adc_value_invalid(x: float) -> bool:
    if not math.isfinite(x):
        return True
    return abs(x) >= _ADC_INVALID_ABS


def _adc_pair_invalid(ch1: float, ch2: float) -> bool:
    return _adc_value_invalid(ch1) or _adc_value_invalid(ch2)


@dataclass(frozen=True)
class ChannelSnapshot:
    kohm:  Optional[float]
    state: str   # "idle" | "measuring" | "no_signal" | "low_z" | "pair_ok" | "high_z" | "open"
    phase: str   # "idle" | "measuring" | "good" | "bad"
    hint:  Optional[str]
    kohm_raw: Optional[float] = None   # THIS window's un-smoothed estimate; the
                                       # enter streak requires raw AND smoothed
                                       # to agree, so EMA lag can never finish
                                       # a streak the electrode did not earn


@dataclass(frozen=True)
class EarSnapshot:
    ch1: ChannelSnapshot
    ch2: ChannelSnapshot


@dataclass(frozen=True)
class ImpedanceSnapshot:
    left:  Optional[EarSnapshot]
    right: Optional[EarSnapshot]


_IDLE_SNAPSHOT      = ChannelSnapshot(kohm=None, state="idle",      phase="idle",      hint=None)
_MEASURING_SNAPSHOT = ChannelSnapshot(kohm=None, state="measuring", phase="measuring", hint=None)


class ChannelImpedanceEstimator:
    """256-sample ring buffer + periodic Goertzel at 31.25 Hz.

    Per the hardware team's shipping spec (2026-08-19):
      - samples carry their TRUE stream position from the transport's admission
      - the window is 256 positions of ELAPSED time, minimum half present
      - single-bin DFT at 31.25 Hz evaluated against those true positions
      - seeded EMA, 0.7 previous + 0.3 new, each 500 ms
      - armed 0 Ohm is no_signal, never a pass; worn() is the 2.3 MOhm verdict
    """

    def __init__(self, settle_sec: float = TONE_SETTLE_SEC):
        # settle_sec: how much of the epoch's head to discard (tone ramp-up).
        # Production always uses the default; unit tests that probe the DFT
        # and coverage math (not arm-time behaviour) may pass 0.
        self._settle_sec = settle_sec
        # samples ride with their TRUE position in the stream (the transport's
        # admission index), so the tone is measured where it actually happened
        self._buf: deque = deque(maxlen=IMPEDANCE_WINDOW_SAMPLES)   # (uV, abs_idx)
        self._tbuf: deque = deque(maxlen=IMPEDANCE_WINDOW_SAMPLES)
        self._last_compute_ms: float = 0.0
        self._smoothed_kohm: Optional[float] = None
        self._last_raw_kohm: Optional[float] = None
        self._last_snapshot: ChannelSnapshot = _IDLE_SNAPSHOT
        self._fallback_idx = 0     # only for callers that supply no index
        self._epoch_t0: Optional[float] = None   # first push of this epoch
        self._last_top_idx: Optional[int] = None # newest position at last compute

    def push_sample(self, raw_adc: float, t_mono: float, abs_idx: Optional[int] = None) -> None:
        """Append one EEG sample (raw ADC count), its timestamp, and its TRUE
        position in the stream. Position is what makes the estimate survive a
        lossy link; without it a caller gets the old spliced behaviour."""
        if abs_idx is None:
            self._fallback_idx += 1
            abs_idx = self._fallback_idx
        if self._epoch_t0 is None:
            self._epoch_t0 = t_mono
        if t_mono - self._epoch_t0 < self._settle_sec:
            return          # partial tone; see TONE_SETTLE_SEC above
        self._buf.append((raw_adc * LSB_UV_PER_COUNT, int(abs_idx)))
        self._tbuf.append(t_mono)

    def compute_if_ready(self, armed: bool, now_ms: float) -> ChannelSnapshot:
        if not armed:
            self._last_snapshot = _IDLE_SNAPSHOT
            return _IDLE_SNAPSHOT

        # COVERAGE GATE (spec B.1). The window is 256 samples of ELAPSED stream
        # time, judged by the true indices, not merely 256 samples that happen to
        # be present. Under half present returns "measuring" (a null verdict),
        # never a number: on a lossy link the alternative was a phase-rotated
        # tone whose amplitude collapsed, whose Z clamped at 0, and whose 0 read
        # as a perfect contact.
        present = self._present_in_window()
        if present is None or present < int(IMPEDANCE_WINDOW_SAMPLES * MIN_COVERAGE):
            self._last_snapshot = _MEASURING_SNAPSHOT
            return _MEASURING_SNAPSHOT

        if (now_ms - self._last_compute_ms) < IMPEDANCE_REFRESH_MS \
                and self._smoothed_kohm is not None:
            return self._last_snapshot

        # FROZEN BUFFER GUARD. Without new samples since the last compute this
        # would recompute the identical window and hand the verdict "fresh"
        # trusted evidence every 500 ms off a dead link - which made the
        # gate's staleness demote unreachable. No new samples, no evidence.
        top = self._buf[-1][1]
        if self._last_top_idx is not None and top == self._last_top_idx:
            self._last_snapshot = _MEASURING_SNAPSHOT
            return _MEASURING_SNAPSHOT
        self._last_top_idx = top

        amp_uv   = self._binned_amplitude_uv()
        kohm_raw = self._amplitude_to_kohm(amp_uv)
        self._apply_ema(kohm_raw)
        self._last_raw_kohm = kohm_raw
        self._last_compute_ms = now_ms

        k     = self._smoothed_kohm
        state = self._map_state(k)
        phase = self._map_phase(k)
        hint  = self._hint_for_state(state)
        snap = ChannelSnapshot(kohm=k, state=state, phase=phase, hint=hint,
                               kohm_raw=kohm_raw)
        self._last_snapshot = snap
        return snap

    def reset(self) -> None:
        self._buf.clear()
        self._tbuf.clear()
        self._last_compute_ms = 0.0
        self._smoothed_kohm   = None
        self._last_raw_kohm   = None
        self._last_snapshot   = _IDLE_SNAPSHOT
        self._epoch_t0        = None
        self._last_top_idx    = None

    # ----- internals -----

    def _present_in_window(self) -> Optional[int]:
        """How many samples are PRESENT in the last 256 positions of elapsed
        stream time. The buffer holds up to 256 samples, but on a lossy link
        those can span far more than 256 positions."""
        if len(self._buf) < 8:
            return None
        last_idx = self._buf[-1][1]
        lo = last_idx - IMPEDANCE_WINDOW_SAMPLES
        return sum(1 for (_uv, p) in self._buf if p > lo)

    def _binned_amplitude_uv(self) -> float:
        """Single-bin DFT at 31.25 Hz, evaluated against each sample's TRUE
        position in the stream (spec A.2, the lossy-link variant).

            A = (2/N) * | SUM_i  x[i] * exp(-j*w*p[i]) |,   w = 2*pi*31.25/250

        Why not the plain Goertzel recurrence: it assumes every sample handed to
        it is the next one in time. Splice a dropped packet out of the buffer
        and the two sides of the hole are treated as adjacent, which rotates
        everything after it (10 missing samples at 31.25 Hz is 450 degrees),
        and enough of those rotations cancel the tone against itself. The
        estimate then collapses toward zero no matter what the electrode is
        really doing, and zero clamps to a perfect contact. Evaluating against
        true indices makes a hole cost coverage instead of destroying the
        measurement, and with nothing missing this returns the identical number
        to the Goertzel (parity is asserted in tests/eeg-impedance.test.py).

        31.25 Hz at 250 Hz is exactly bin 32 of a 256-point DFT, so w*p[i] is
        phase-exact for integer positions.
        """
        last_idx = self._buf[-1][1]
        lo = last_idx - IMPEDANCE_WINDOW_SAMPLES
        window = [(uv, p) for (uv, p) in self._buf if p > lo]
        n = len(window)
        if n == 0:
            return 0.0
        mean_uv = sum(uv for uv, _p in window) / n
        w = 2.0 * math.pi * LOFF_INJECTION_HZ / EEG_SAMPLE_RATE_HZ
        re = im = 0.0
        for uv, pos in window:
            x = uv - mean_uv
            ang = w * pos
            re += x * math.cos(ang)
            im -= x * math.sin(ang)
        return (2.0 / n) * math.sqrt(re * re + im * im)

    def _amplitude_to_kohm(self, amp_uv: float) -> float:
        z_ohm = (amp_uv * 1e-6) / I_INJECT_A - R_SERIES_OHM
        if z_ohm < 0.0:
            z_ohm = 0.0
        return z_ohm / 1000.0

    def _apply_ema(self, new_kohm: float) -> None:
        if self._smoothed_kohm is None:
            self._smoothed_kohm = new_kohm
        elif new_kohm * 1000.0 < MIN_PLAUSIBLE_OHM:
            # A raw window in no_signal territory is an electrical event (tone
            # gone, chain broken), never wobble. Blending it would walk the
            # smoothed value DOWN THROUGH the pass band over ~10 ticks - the
            # reviewed decay attack read a desk bud "good" for 6.5 s. Adopt
            # the collapse whole, so the very next snapshot is no_signal.
            self._smoothed_kohm = new_kohm
        else:
            self._smoothed_kohm = (1.0 - EMA_ALPHA) * self._smoothed_kohm \
                                  + EMA_ALPHA * new_kohm

    def _map_state(self, kohm: float) -> str:
        # An armed channel reading EXACTLY 0 Ohm is not a superhuman contact, it
        # is the clamp eating a negative: no injection, wrong command order, or
        # a collapsed estimate. The spec is explicit that this is never a pass.
        # The same goes for a reading under the plausibility floor: that is the
        # missing-lead signature (readings ~1000x low), not a great electrode.
        if kohm <= 0.0 or kohm * 1000.0 < MIN_PLAUSIBLE_OHM:
            return "no_signal"
        if kohm <= LOW_Z_MAX:
            return "low_z"
        if kohm <= PAIR_OK_MAX:
            return "pair_ok"
        if kohm <= HIGH_Z_MAX:
            return "high_z"
        return "open"

    def _map_phase(self, kohm: float) -> str:
        # phase is the QC-pass line some consumers read verbatim; it must not
        # call an untrusted (no_signal / implausibly-low) reading "good"
        if kohm <= 0.0 or kohm * 1000.0 < MIN_PLAUSIBLE_OHM:
            return "bad"
        return "good" if kohm <= QC_GOOD_MAX else "bad"

    def worn(self) -> Optional[bool]:
        """The verdict's one job: is this electrode on skin? None until measured."""
        if self._smoothed_kohm is None:
            return None
        z_ohm = self._smoothed_kohm * 1000.0
        if z_ohm < MIN_PLAUSIBLE_OHM:
            return None          # no_signal / implausibly low: not evidence either way
        return z_ohm <= WORN_PASS_OHM

    def _hint_for_state(self, state: str) -> Optional[str]:
        if state == "no_signal":
            return "reading implausibly low - lead-off tone missing or chain broken; untrusted"
        if state == "high_z":
            return "try re-seating the earbud"
        if state == "open":
            return "no skin contact"
        return None


class EarImpedanceProcessor:
    """Process impedance for one ear (CH1 + CH2)."""

    def __init__(self, side: str = "?", settle_sec: float = TONE_SETTLE_SEC):
        self._side = side
        self.ch1 = ChannelImpedanceEstimator(settle_sec=settle_sec)
        self.ch2 = ChannelImpedanceEstimator(settle_sec=settle_sec)

    def ingest(self, ch1_raw: float, ch2_raw: float, t_mono: float, abs_idx: Optional[int] = None) -> None:
        if _adc_pair_invalid(ch1_raw, ch2_raw):
            return
        self.ch1.push_sample(ch1_raw, t_mono, abs_idx)
        self.ch2.push_sample(ch2_raw, t_mono, abs_idx)

    def snapshot(self, armed: bool, now_ms: float) -> EarSnapshot:
        return EarSnapshot(
            ch1=self.ch1.compute_if_ready(armed, now_ms),
            ch2=self.ch2.compute_if_ready(armed, now_ms),
        )

    def reset(self) -> None:
        self.ch1.reset()
        self.ch2.reset()


# =====================================================================
# WornGate - the asymmetric worn/not-worn verdict for one side.
# ---------------------------------------------------------------------
# The pass threshold has NO headroom to give: worn passes at 2.3 MOhm and
# an unworn bud on a desk reads 3.0-3.7, so past roughly 2.5 a desk bud
# starts to pass and moving the number is off the table. The gate is made
# forgiving by OTHER means, the same enter-vs-stay asymmetry the phone
# app's commit machine uses for zone labels:
#
#   ENTER (strict):  ENTER_CONSEC consecutive trusted estimates at or
#                    under 2.3 MOhm. Any untrusted or failing estimate
#                    resets the count. First verdict lands in ~2.5 s of
#                    clean readings (3 x the 500 ms refresh) instead of
#                    the old flat 5 s wall-clock wait.
#   STAY (tolerant): once genuinely seated, a chew, a jaw shift or a
#                    glance that bounces the estimate does not demote:
#                      <= 2.5 MOhm         keeps good indefinitely
#                      2.5 - 3.0 MOhm      demotes after 4 s sustained
#                      >= 3.0 MOhm         demotes after 1.5 s sustained
#                                          (a removed bud reads open fast)
#                      no_signal / stale   demotes immediately (electrical
#                                          evidence, not wobble)
#
# THE INVARIANT THAT OVERRIDES EVERYTHING: a bud not on a person must
# never reach good, even briefly. A desk bud reads 3.0-3.7 MOhm, which
# can never satisfy the enter rule; noise, drops and duplicates starve
# the coverage gate into null verdicts, which never advance the enter
# count; the missing-lead mode reads implausibly low, which is untrusted
# by the floor above. The tolerant band exists only AFTER a real enter.
# =====================================================================

WORN_ENTER_CONSEC     = 3
WORN_ENTER_MIN_GAP_S  = 0.4          # a cached snapshot must not count twice
WORN_ENTER_MAX_GAP_S  = 2.5          # estimates further apart than this are not
                                     # CONSECUTIVE: a streak cannot be stitched
                                     # across a stall or a long silence
WORN_STAY_OHM         = 2_500_000.0  # the doc's own desk-bud onset boundary
WORN_UNWORN_OHM       = 3_000_000.0  # unmistakably off the head
WORN_GREY_DEMOTE_S    = 4.0
WORN_UNWORN_DEMOTE_S  = 1.5
WORN_GATE_STALE_S     = 3.5          # no trusted reading this long = know nothing


class WornGate:
    """State machine over one side's channel snapshots. States:
    "checking" (no verdict yet), "good", "bad". any_required semantics:
    the best (lowest) trusted channel speaks for the side."""

    def __init__(self, enter_ohm: float = WORN_PASS_OHM,
                 stay_ohm: float = WORN_STAY_OHM,
                 unworn_ohm: float = WORN_UNWORN_OHM):
        self.enter_ohm = enter_ohm
        self.stay_ohm = stay_ohm
        self.unworn_ohm = unworn_ohm
        self.reset()

    def reset(self) -> None:
        self.state = "checking"
        self._enter_count = 0
        self._last_counted = float("-inf")   # the FIRST estimate always counts
        self._last_trusted = None     # monotonic time of the last trusted estimate
        self._bad_since = None        # start of a continuous stretch ABOVE stay
        self._unworn_since = None     # start of a continuous stretch AT/ABOVE unworn

    @staticmethod
    def _best_trusted_ohm(channels):
        """channels: iterable of (kohm, state) or (kohm, state, kohm_raw).
        Returns (best_ohm, enter_ok): the lowest trusted smoothed impedance in
        ohms (None when no channel can be trusted), and whether any channel
        qualifies for the ENTER streak - which demands the RAW window estimate
        agree with the smoothed one, so EMA lag (a desk bud riding a recently
        worn or tone-ramp-depressed average through the pass band) can never
        finish a streak the electrode did not earn. no_signal (which includes
        the implausibly-low missing-lead mode), idle and measuring are not
        evidence."""
        best = None
        enter_ok = False
        for c in channels:
            kohm, state = c[0], c[1]
            raw = c[2] if len(c) > 2 else kohm
            if kohm is None or state in ("no_signal", "idle", "measuring"):
                continue
            ohm = kohm * 1000.0
            if best is None or ohm < best:
                best = ohm
            raw_ohm = None if raw is None else raw * 1000.0
            if ohm <= WORN_PASS_OHM and raw_ohm is not None \
                    and MIN_PLAUSIBLE_OHM <= raw_ohm <= WORN_PASS_OHM:
                enter_ok = True
        return best, enter_ok

    def update(self, channels, now_mono: float) -> str:
        best, enter_ok = self._best_trusted_ohm(channels)
        has_no_signal = any(c[1] == "no_signal" for c in channels)

        if best is not None:
            self._last_trusted = now_mono
        stale = (self._last_trusted is not None
                 and (now_mono - self._last_trusted) > WORN_GATE_STALE_S)

        if self.state != "good":
            # ---- ENTER: strict ----
            if enter_ok and best is not None and best <= self.enter_ohm:
                gap = now_mono - self._last_counted
                if gap > WORN_ENTER_MAX_GAP_S:
                    self._enter_count = 0     # too old to be part of one streak
                if gap >= WORN_ENTER_MIN_GAP_S:
                    self._enter_count += 1
                    self._last_counted = now_mono
                if self._enter_count >= WORN_ENTER_CONSEC:
                    self.state = "good"
                    self._bad_since = None
                    self._unworn_since = None
            elif best is not None or has_no_signal:
                # a failing or untrusted estimate breaks the streak; silence
                # (measuring) merely does not advance it
                self._enter_count = 0
            if self.state != "good" and self._last_trusted is not None                     and best is None and stale:
                self._enter_count = 0
            return self.state

        # ---- STAY: tolerant, with the hard edges kept hard ----
        if has_no_signal and best is None:
            # electrical evidence of a broken chain, not wobble
            self._demote()
            return self.state
        if stale:
            self._demote()
            return self.state
        if best is None:
            return self.state           # silence inside the staleness window
        if best <= self.stay_ohm:
            self._bad_since = None
            self._unworn_since = None
            return self.state
        # Two demote clocks, ACCUMULATED not exclusive: _bad_since runs from
        # the first reading above stay and keeps running across the 3.0 MOhm
        # boundary (readings wobbling grey<->unworn used to restart the timer
        # on every crossing - a removed bud straddling 3.0 stayed good for two
        # minutes in review, forever in principle); _unworn_since additionally
        # runs while readings sit at/above unworn, for the fast demote.
        if self._bad_since is None:
            self._bad_since = now_mono
        if best >= self.unworn_ohm:
            if self._unworn_since is None:
                self._unworn_since = now_mono
        else:
            self._unworn_since = None
        if now_mono - self._bad_since >= WORN_GREY_DEMOTE_S:
            self._demote()
        elif self._unworn_since is not None \
                and now_mono - self._unworn_since >= WORN_UNWORN_DEMOTE_S:
            self._demote()
        return self.state

    def _demote(self) -> None:
        self.state = "bad"
        self._enter_count = 0
        self._bad_since = None
        self._unworn_since = None
