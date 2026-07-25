"""Zone SDK - electrode impedance estimation.

Faithful port of the desktop app's impedance detector
(see docs/IMPEDANCE_CHECK.md, sections 4.8-4.13 and 6).
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from statistics import median
from typing import Optional


# ----- Constants (from docs/IMPEDANCE_CHECK.md section 6) -----

IMPEDANCE_WINDOW_SAMPLES = 256
IMPEDANCE_REFRESH_MS     = 500.0
LOFF_INJECTION_HZ        = 31.25
EEG_SAMPLE_RATE_HZ       = 250
I_INJECT_A               = 24e-9           # ADS1299 lead-off current (24 nA)
R_SERIES_OHM             = 2200.0          # Zone hardware series resistor
LSB_UV_PER_COUNT         = 4.5 / (24.0 * 8388607.0) * 1e6  # ADS1299 uV / count
EMA_ALPHA                = 0.25            # lower = calmer UI; raw is also median-filtered
_RAW_KOHM_MEDIAN_LEN   = 3               # suppress single 500 ms window spikes

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

    Matches docs/IMPEDANCE_CHECK.md steps 8-13, plus:
      - keep last 256 samples (~1.024 s at 250 Hz)
      - at most once per 500 ms, run Goertzel over the buffer
      - median of the last 3 raw kΩ estimates (reduces dual-BLE / motion glitches)
      - EMA-smooth, then map state/phase
    """

    def __init__(self):
        self._buf: deque = deque(maxlen=IMPEDANCE_WINDOW_SAMPLES)
        self._tbuf: deque = deque(maxlen=IMPEDANCE_WINDOW_SAMPLES)
        self._kohm_raw_ring: deque = deque(maxlen=_RAW_KOHM_MEDIAN_LEN)
        self._last_compute_ms: float = 0.0
        self._smoothed_kohm: Optional[float] = None
        self._last_snapshot: ChannelSnapshot = _IDLE_SNAPSHOT

    def push_sample(self, raw_adc: float, t_mono: float) -> None:
        """Append one EEG sample (raw ADC count) and local monotonic timestamp."""
        self._buf.append(raw_adc * LSB_UV_PER_COUNT)
        self._tbuf.append(t_mono)

    def compute_if_ready(self, armed: bool, now_ms: float) -> ChannelSnapshot:
        if not armed:
            self._last_snapshot = _IDLE_SNAPSHOT
            return _IDLE_SNAPSHOT

        if len(self._buf) < IMPEDANCE_WINDOW_SAMPLES:
            self._last_snapshot = _MEASURING_SNAPSHOT
            return _MEASURING_SNAPSHOT

        fs_hz = self._effective_fs_hz()
        if fs_hz is not None and fs_hz < IMPEDANCE_MIN_FS_HZ:
            snap = ChannelSnapshot(
                kohm=None,
                state="measuring",
                phase="measuring",
                hint="ear BLE rate too low for impedance — reconnect (left first)",
            )
            self._last_snapshot = snap
            return snap

        if (now_ms - self._last_compute_ms) < IMPEDANCE_REFRESH_MS \
                and self._smoothed_kohm is not None:
            return self._last_snapshot

        amp_uv   = self._goertzel_amplitude_uv()
        kohm_raw = self._amplitude_to_kohm(amp_uv)
        self._kohm_raw_ring.append(kohm_raw)
        kohm_stable = median(self._kohm_raw_ring)
        self._apply_ema(kohm_stable)
        self._last_compute_ms = now_ms

        k     = self._smoothed_kohm
        state = self._map_state(k)
        phase = self._map_phase(k)
        hint  = self._hint_for_state(state)
        snap = ChannelSnapshot(kohm=k, state=state, phase=phase, hint=hint)
        if fs_hz is not None and fs_hz < _IMPEDANCE_FS_TRUST_NYQ:
            low = _APPROXIMATE_FS_HINT
            snap = ChannelSnapshot(
                kohm=snap.kohm,
                state=snap.state,
                phase=snap.phase,
                hint=f"{snap.hint}; {low}" if snap.hint else low,
            )
        self._last_snapshot = snap
        return snap

    def reset(self) -> None:
        self._buf.clear()
        self._tbuf.clear()
        self._kohm_raw_ring.clear()
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

    def _goertzel_amplitude_uv(self) -> float:
        """Standard Goertzel filter at 31.25 Hz over the 256-sample window.

        Matches docs/IMPEDANCE_CHECK.md step 9:
            coeff = 2*cos(omega)
            for each x: s = x + coeff*s1 - s2; s2 = s1; s1 = s
            power     = s1^2 + s2^2 - coeff*s1*s2
            amplitude = (2/N) * sqrt(power)
        """
        N = len(self._buf)
        samples = list(self._buf)
        mean_uv = sum(samples) / N

        avg_dt = self._mean_sample_dt()
        if avg_dt is None:
            avg_dt = 1.0 / EEG_SAMPLE_RATE_HZ

        omega = 2.0 * math.pi * LOFF_INJECTION_HZ * avg_dt
        coeff = 2.0 * math.cos(omega)

        s1 = 0.0
        s2 = 0.0
        for uv in samples:
            s  = (uv - mean_uv) + coeff * s1 - s2
            s2 = s1
            s1 = s

        power = s1 * s1 + s2 * s2 - coeff * s1 * s2
        if power < 0.0:
            power = 0.0
        return 2.0 * math.sqrt(power) / N

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
        if kohm <= LOW_Z_MAX:
            return "low_z"
        if kohm <= PAIR_OK_MAX:
            return "pair_ok"
        if kohm <= HIGH_Z_MAX:
            return "high_z"
        return "open"

    def _map_phase(self, kohm: float) -> str:
        return "good" if kohm <= QC_GOOD_MAX else "bad"

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

    def ingest(self, ch1_raw: float, ch2_raw: float, t_mono: float) -> None:
        if _adc_pair_invalid(ch1_raw, ch2_raw):
            return
        self.ch1.push_sample(ch1_raw, t_mono)
        self.ch2.push_sample(ch2_raw, t_mono)

    def snapshot(self, armed: bool, now_ms: float) -> EarSnapshot:
        return EarSnapshot(
            ch1=self.ch1.compute_if_ready(armed, now_ms),
            ch2=self.ch2.compute_if_ready(armed, now_ms),
        )

    def reset(self) -> None:
        self.ch1.reset()
        self.ch2.reset()
