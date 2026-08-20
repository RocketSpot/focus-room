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

# kohm thresholds
LOW_Z_MAX   = 50
PAIR_OK_MAX = 150
HIGH_Z_MAX  = 500
QC_GOOD_MAX = 800

# ADS1299 / transport sends ±8388608 when a channel is inactive or data missing.
_ADC_INVALID_ABS = 8_387_000
# Goertzel omega = 2π f_inj Δt ; Δt must match actual mean sample spacing on each
# ear.  Under Windows dual-BLE one link often runs ~35–55 Hz while the other is
# ~250 Hz — using 1/250 for both makes the slow side report bogus kΩ (often
# falsely low “good contact”).  Clamp inferred spacing to a plausible range.
_DT_MIN = 1.0 / 420.0
_DT_MAX = 1.0 / 15.0
# Lead-off tone is 31.25 Hz — need Fs > 2× that (Nyquist). Below this,
# Goertzel amplitude is not trustworthy even with correct Δt (strict mode).
IMPEDANCE_MIN_FS_HZ = 70.0
_IMPEDANCE_FS_TRUST_NYQ = 2.0 * LOFF_INJECTION_HZ  # 62.5 Hz
_APPROXIMATE_FS_HINT = (
    "approximate: BLE below ideal Nyquist for 31.25 Hz (common ~50 Hz Windows link)"
)


def _adc_value_invalid(x: float) -> bool:
    if not math.isfinite(x):
        return True
    return abs(x) >= _ADC_INVALID_ABS


def _adc_pair_invalid(ch1: float, ch2: float) -> bool:
    return _adc_value_invalid(ch1) or _adc_value_invalid(ch2)


@dataclass(frozen=True)
class ChannelSnapshot:
    kohm:  Optional[float]
    state: str   # "idle" | "measuring" | "low_z" | "pair_ok" | "high_z" | "open"
    phase: str   # "idle" | "measuring" | "good" | "bad"
    hint:  Optional[str]


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

    def __init__(self):
        # samples ride with their TRUE position in the stream (the transport's
        # admission index), so the tone is measured where it actually happened
        self._buf: deque = deque(maxlen=IMPEDANCE_WINDOW_SAMPLES)   # (uV, abs_idx)
        self._tbuf: deque = deque(maxlen=IMPEDANCE_WINDOW_SAMPLES)
        self._last_compute_ms: float = 0.0
        self._smoothed_kohm: Optional[float] = None
        self._last_snapshot: ChannelSnapshot = _IDLE_SNAPSHOT
        self._fallback_idx = 0     # only for callers that supply no index

    def push_sample(self, raw_adc: float, t_mono: float, abs_idx: Optional[int] = None) -> None:
        """Append one EEG sample (raw ADC count), its timestamp, and its TRUE
        position in the stream. Position is what makes the estimate survive a
        lossy link; without it a caller gets the old spliced behaviour."""
        if abs_idx is None:
            self._fallback_idx += 1
            abs_idx = self._fallback_idx
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

        amp_uv   = self._binned_amplitude_uv()
        kohm_raw = self._amplitude_to_kohm(amp_uv)
        self._apply_ema(kohm_raw)
        self._last_compute_ms = now_ms

        k     = self._smoothed_kohm
        state = self._map_state(k)
        phase = self._map_phase(k)
        hint  = self._hint_for_state(state)
        snap = ChannelSnapshot(kohm=k, state=state, phase=phase, hint=hint)
        self._last_snapshot = snap
        return snap

    def reset(self) -> None:
        self._buf.clear()
        self._tbuf.clear()
        self._last_compute_ms = 0.0
        self._smoothed_kohm   = None
        self._last_snapshot   = _IDLE_SNAPSHOT

    # ----- internals -----

    def _mean_sample_dt(self) -> Optional[float]:
        N = len(self._buf)
        times = list(self._tbuf)
        if N < 2 or len(times) != N or times[-1] <= times[0]:
            return None
        avg_dt = (times[-1] - times[0]) / (N - 1)
        return max(_DT_MIN, min(_DT_MAX, avg_dt))

    def _effective_fs_hz(self) -> Optional[float]:
        dt = self._mean_sample_dt()
        if dt is None or dt <= 0.0:
            return None
        return 1.0 / dt

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
        else:
            self._smoothed_kohm = (1.0 - EMA_ALPHA) * self._smoothed_kohm \
                                  + EMA_ALPHA * new_kohm

    def _map_state(self, kohm: float) -> str:
        # An armed channel reading EXACTLY 0 Ohm is not a superhuman contact, it
        # is the clamp eating a negative: no injection, wrong command order, or
        # a collapsed estimate. The spec is explicit that this is never a pass.
        if kohm <= 0.0:
            return "no_signal"
        if kohm <= LOW_Z_MAX:
            return "low_z"
        if kohm <= PAIR_OK_MAX:
            return "pair_ok"
        if kohm <= HIGH_Z_MAX:
            return "high_z"
        return "open"

    def _map_phase(self, kohm: float) -> str:
        return "good" if kohm <= QC_GOOD_MAX else "bad"

    def worn(self) -> Optional[bool]:
        """The verdict's one job: is this electrode on skin? None until measured."""
        if self._smoothed_kohm is None:
            return None
        z_ohm = self._smoothed_kohm * 1000.0
        if z_ohm <= 0.0:
            return None          # no_signal is not evidence either way
        return z_ohm <= WORN_PASS_OHM

    def _hint_for_state(self, state: str) -> Optional[str]:
        if state == "high_z":
            return "try re-seating the earbud"
        if state == "open":
            return "no skin contact"
        return None


class EarImpedanceProcessor:
    """Process impedance for one ear (CH1 + CH2)."""

    def __init__(self, side: str = "?"):
        self._side = side
        self.ch1 = ChannelImpedanceEstimator()
        self.ch2 = ChannelImpedanceEstimator()

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
