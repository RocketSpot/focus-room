"""
Zone SDK - Signal Processing Module
processing pipeline
"""

# PEP 604 unions ("int | None") appear in annotations below. Without this
# future-import they are EVALUATED on import, so Python 3.9 died with a
# TypeError — which main.py's classifier reported as engine_init_failed
# instead of the honest sdk_missing. Deferring annotations keeps the import
# clean everywhere and the failure story accurate.
from __future__ import annotations

import numpy as np
from scipy import signal
from scipy.integrate import simpson
from datetime import datetime
from typing import  Dict
import logging

try:
    import pywt

    _HAS_PYWT = True
except ImportError:
    _HAS_PYWT = False

try:
    from .models import RawEEGData, BrainwaveData, MetricsData
except ImportError:
    from models import RawEEGData, BrainwaveData, MetricsData

logger = logging.getLogger(__name__)

# ===================== config.json =====================

CONFIG = {
    "adc": {
        "vref": 4.5,
        "gain": 24,
        "adc_bits": 24,
        "sample_rate": 250,
        "num_channels": 4,
        "channel_names": ["Left-A", "Left-B", "Right-A", "Right-B"],
    },
    "saturation": {
        "margin_counts": 100,
        "critical_threshold_pct": 1.0,
        "warning_threshold_pct": 0.1,
    },
    "filter": {
        "bandpass_low_hz": 0.5,
        "bandpass_high_hz": 40.0,
        "bandpass_order": 4,
        "notch_freq_hz": 50.0,
        "notch_harmonics": [50.0, 60.0, 100.0, 120.0],
        "notch_q_factor": 30.0,
        "detrend_enabled": True,
        "detrend_type": "linear",
    },
    "artifact": {
        "amplitude_enabled": True,
        "amplitude_percentile": 99.5,
        "amplitude_multiplier": 1.5,
        "gradient_enabled": True,
        "gradient_percentile": 99.0,
        "gradient_multiplier": 2.0,
        "flatline_enabled": True,
        "flatline_std_threshold_uv": 0.5,
        "flatline_min_duration_sec": 0.2,
        "zscore_enabled": True,
        "zscore_threshold": 4.0,
        "saturation_as_artifact": True,
        "interpolation_method": "linear",
        "max_interpolation_pct": 30.0,
    },
    "spectral": {"window_sec": 2.0, "overlap_ratio": 0.5, "window_type": "hann"},
    "bands": {
        "delta": [0.5, 4.0],
        "theta": [4.0, 8.0],
        "alpha": [8.0, 13.0],
        "beta": [13.0, 30.0],
        "gamma": [30.0, 45.0],
        "sub_bands": {
            "low_alpha": [8.0, 10.0],
            "high_alpha": [10.0, 13.0],
            "low_beta": [13.0, 18.0],
            "high_beta": [18.0, 30.0],
            "smr": [12.0, 15.0],
        },
    },
    "metrics": {
        "focus_formula": "beta / (alpha + theta)",
        "focus_typical_range": [0.3, 2.5],
        "stress_formula": "(beta + high_beta) / alpha",
        "stress_typical_range": [0.5, 4.0],
        "readiness_formula": "alpha / (beta + high_beta)",
        "readiness_typical_range": [0.2, 2.5],
        "engagement_formula": "beta / (alpha + theta)",
        "engagement_typical_range": [0.3, 2.5],
        "drowsiness_formula": "(theta + delta) / (alpha + beta)",
        "drowsiness_typical_range": [0.3, 3.0],
        "output_min": 0.0,
        "output_max": 100.0,
        "smoothing_enabled": True,
        "smoothing_alpha": 0.3,
    },
}


def get_scale_factor() -> float:
    """
    Calculate scale factor to convert RAW ADC counts to microvolts (µV)
    """
    adc = CONFIG["adc"]
    max_count = 2 ** (adc["adc_bits"] - 1) - 1
    scale_factor = (adc["vref"] / adc["gain"] / max_count) * 1e6

    logger.debug(f"Scale factor: {scale_factor:.6f} µV/count")
    return scale_factor


class ADCConverter:
    """
    ADC to microvolts converter
    """

    def __init__(self):
        self.scale_factor = get_scale_factor()
        adc = CONFIG["adc"]
        self.max_count = 2 ** (adc["adc_bits"] - 1) - 1
        self.min_count = -(2 ** (adc["adc_bits"] - 1))
        self.margin = CONFIG["saturation"]["margin_counts"]

        # logger.info(
        #     f"ADC Converter initialized: scale={self.scale_factor:.6f} µV/count"
        # )
        # logger.info(f"  Valid range: {self.min_count} to {self.max_count} counts")

    def convert(self, data, remove_dc=True):
        """
        Convert raw ADC counts to microvolts (µV)


        Args:
            data: numpy array of RAW ADC counts
            remove_dc: whether to remove DC offset

        Returns:
            numpy array in microvolts (µV)
        """
        logger.debug(f"Converting {data.shape} samples from counts to µV")

        # Convert to float and scale to µV
        data_uv = data.astype(np.float64) * self.scale_factor

        if remove_dc:
            # Remove DC offset (mean) from each channel
            data_uv -= np.mean(data_uv, axis=0, keepdims=True)
            logger.debug("DC offset removed")

        logger.debug(
            f"  Converted range: [{np.min(data_uv):.2f}, {np.max(data_uv):.2f}] µV"
        )
        return data_uv

    def check_saturation(self, data):
        """
        Check for ADC saturation
        """
        margin = self.margin
        sat_high = np.sum(data >= self.max_count - margin, axis=0)
        sat_low = np.sum(data <= self.min_count + margin, axis=0)
        total = data.shape[0]

        saturated_pct = ((sat_high + sat_low) / total * 100).tolist()
        any_saturated = bool(np.any(sat_high + sat_low > 0))

        # Check thresholds 
        critical_pct = CONFIG["saturation"]["critical_threshold_pct"]
        warning_pct = CONFIG["saturation"]["warning_threshold_pct"]

        result = {
            "saturated_pct": saturated_pct,
            "any_saturated": any_saturated,
            "critical": any(pct > critical_pct for pct in saturated_pct),
            "warning": any(pct > warning_pct for pct in saturated_pct),
        }

        if result["critical"]:
            logger.warning(f"CRITICAL SATURATION: {saturated_pct}")
        elif result["warning"]:
            logger.warning(f"Saturation warning: {saturated_pct}")

        return result


class EEGFilter:
    """
    EEG signal filtering
    """

    def __init__(self):
        cfg = CONFIG["filter"]
        fs = CONFIG["adc"]["sample_rate"]
        nyq = fs / 2

        # logger.info("Initializing EEG filters...")

        # Bandpass filter (1-45 Hz by default)
        low = cfg["bandpass_low_hz"] / nyq
        high = cfg["bandpass_high_hz"] / nyq
        self.bp_b, self.bp_a = signal.butter(
            cfg["bandpass_order"], [low, high], btype="band"
        )
        # logger.info(
        #     f"  Bandpass: {cfg['bandpass_low_hz']}-{cfg['bandpass_high_hz']} Hz (order {cfg['bandpass_order']})"
        # )

        # Notch filters for all harmonics (50, 60, 100, 120 Hz)
        self.notch_coeffs = []
        for freq in cfg.get("notch_harmonics", [50.0, 60.0, 100.0, 120.0]):
            b, a = signal.iirnotch(freq, cfg["notch_q_factor"], fs)
            self.notch_coeffs.append((b, a))
        # logger.info(
        #     f"  Notch filters: {cfg['notch_harmonics']} Hz (Q={cfg['notch_q_factor']})"
        # )

        self.detrend_enabled = cfg.get("detrend_enabled", True)
        self.detrend_type = cfg.get("detrend_type", "linear")
        # logger.info(
        #     f"  Detrend: {'enabled' if self.detrend_enabled else 'disabled'} ({self.detrend_type})"
        # )

    def filter(self, data):
        """
        Apply all filters to the data

        """
        logger.debug(f"Filtering {data.shape} samples...")

        # Step 1: Detrend if enabled
        if self.detrend_enabled:
            if self.detrend_type == "linear":
                data = signal.detrend(data, axis=0, type="linear")
            else:
                data = signal.detrend(data, axis=0)
            # logger.debug("  Detrended")

        # Step 2: Bandpass filter
        data = signal.filtfilt(self.bp_b, self.bp_a, data, axis=0)
        # logger.debug("  Bandpass filtered")

        # Step 3: Notch filters for all harmonics
        for i, (b, a) in enumerate(self.notch_coeffs):
            data = signal.filtfilt(b, a, data, axis=0)
        # logger.debug(f"  Applied {len(self.notch_coeffs)} notch filters")

        return data


# ===================== VISUALIZATION FILTER (DISPLAY ONLY) =====================


class VisualizationFilter:
    """
    Online filter for EEG visualization only.
    Does NOT affect the processing pipeline used for FFT / metrics.

    Per-chunk (online, causal) stage – applied inside DataBuffer.add_data():
      1. ADC counts → µV  (pure scaling)
      2. Bandpass  1–45 Hz  (Chebyshev Type II, steepness 0.85, 60 dB stopband)
      3. Band-stop 48–52 Hz (Butterworth order 4)
      4. Band-stop 58–62 Hz (Butterworth order 4)

    Per-frame (block) stage – applied inside DataBuffer.get_plot_data():
      5. Linear detrend   (scipy.signal.detrend)
      6. Wavelet denoise   (BayesShrink + MAD noise estimate)

    All IIR filters use SOS form with per-channel persistent state
    (sosfilt + zi) so successive small chunks are filtered continuously
    without transient artefacts at chunk boundaries.
    """

    def __init__(self, n_channels: int = 4):
        fs = CONFIG["adc"]["sample_rate"]
        nyq = fs / 2.0

        self._scale_factor = get_scale_factor()
        self._n_channels = n_channels
        self._fs = fs
        self._target_uv = 500.0

        # ---- Bandpass 1–45 Hz (Chebyshev Type II) ----
        # Steepness 0.85 → transition width = 15 % of each edge frequency
        # Stopband attenuation = 60 dB, passband ripple ≤ 1 dB
        wp = [1.0 / nyq, 45.0 / nyq]
        ws = [
            max(0.5, 1.0 - 0.15 * 1.0) / nyq,   # 0.85 Hz
            (45.0 + 0.15 * 45.0) / nyq,           # 51.75 Hz
        ]
        self._sos_bp = signal.iirdesign(
            wp, ws, gpass=1, gstop=60, ftype="cheby2", output="sos"
        )

        # ---- Band-stop (notch) 48–52 Hz ----
        self._sos_notch50 = signal.butter(
            4, [48.0 / nyq, 52.0 / nyq], btype="bandstop", output="sos"
        )
        # ---- Band-stop (notch) 58–62 Hz ----
        self._sos_notch60 = signal.butter(
            4, [58.0 / nyq, 62.0 / nyq], btype="bandstop", output="sos"
        )

        self._init_states()

    # ---- internal helpers ----

    def _init_states(self):
        """Create / reset per-channel filter and adaptive states."""
        n = self._n_channels
        self._zi_bp = [signal.sosfilt_zi(self._sos_bp) for _ in range(n)]
        self._zi_n50 = [signal.sosfilt_zi(self._sos_notch50) for _ in range(n)]
        self._zi_n60 = [signal.sosfilt_zi(self._sos_notch60) for _ in range(n)]
        self._initialized = [False] * n
        self._dc_estimate = [None] * n   # running DC offset per channel
        self._amp_estimate = [None] * n  # running amplitude per channel

    def reset(self, n_channels: int | None = None):
        """Reset all filter states (call when streaming restarts)."""
        if n_channels is not None:
            self._n_channels = n_channels
        self._init_states()

    @staticmethod
    def _wavelet_denoise(data, wavelet="db4"):
        """
        BayesShrink wavelet denoising with MAD noise estimation.

        1. DWT decompose (up to 4 levels)
        2. Estimate noise sigma from finest detail coefficients (median rule)
        3. BayesShrink soft threshold per detail level
        4. Inverse DWT reconstruct
        """
        max_level = pywt.dwt_max_level(len(data), wavelet)
        level = min(max_level, 4)
        if level < 1:
            return data

        coeffs = pywt.wavedec(data, wavelet, level=level)

        # MAD noise estimate: sigma = median(|d_finest|) / 0.6745
        sigma = np.median(np.abs(coeffs[-1])) / 0.6745
        if sigma < 1e-10:
            return data

        sigma_sq = sigma ** 2

        denoised_coeffs = [coeffs[0]]  # approximation kept intact
        for d in coeffs[1:]:
            sigma_d_sq = np.mean(d ** 2)
            sigma_x_sq = max(sigma_d_sq - sigma_sq, 0.0)
            if sigma_x_sq > 0:
                thresh = sigma_sq / np.sqrt(sigma_x_sq)
            else:
                thresh = np.max(np.abs(d))
            denoised_coeffs.append(pywt.threshold(d, thresh, mode="soft"))

        rec = pywt.waverec(denoised_coeffs, wavelet)
        return rec[: len(data)]

    # ---- public API ----

    def process(self, raw_counts, channel_idx: int) -> np.ndarray:
        """
        Online IIR filtering of one channel (called per chunk).

        Pipeline: ADC→µV → Bandpass 1–45 Hz → Notch 48–52 → Notch 58–62

        Args:
            raw_counts: 1-D array-like of raw ADC integer counts.
            channel_idx: channel index (0-3) for per-channel state.

        Returns:
            1-D numpy array of filtered values in µV.
        """
        if channel_idx >= self._n_channels:
            self.reset(n_channels=channel_idx + 1)

        data = np.asarray(raw_counts, dtype=np.float64) * self._scale_factor

        if len(data) == 0:
            return data

        # Initialise filter states with the first sample so the DC step
        # does not produce a large start-up transient.
        if not self._initialized[channel_idx]:
            x0 = data[0]
            self._zi_bp[channel_idx] *= x0
            self._zi_n50[channel_idx] *= x0
            self._zi_n60[channel_idx] *= x0
            self._initialized[channel_idx] = True

        # 1. Bandpass 1–45 Hz (Cheby2, 60 dB stopband)
        data, self._zi_bp[channel_idx] = signal.sosfilt(
            self._sos_bp, data, zi=self._zi_bp[channel_idx]
        )
        # 2. Band-stop 48–52 Hz
        data, self._zi_n50[channel_idx] = signal.sosfilt(
            self._sos_notch50, data, zi=self._zi_n50[channel_idx]
        )
        # 3. Band-stop 58–62 Hz
        data, self._zi_n60[channel_idx] = signal.sosfilt(
            self._sos_notch60, data, zi=self._zi_n60[channel_idx]
        )

        # 4. Adaptive DC removal – the causal IIR bandpass takes time to
        #    reject the large electrode DC offset (~kµV).  A fast-adapting
        #    running mean tracks and subtracts residual DC so the buffer
        #    stores values centred at zero from the very first chunk.
        chunk_mean = np.mean(data)
        dc = self._dc_estimate[channel_idx]
        if dc is None:
            self._dc_estimate[channel_idx] = chunk_mean
        else:
            alpha_dc = 0.15  # fast adaptation to kill DC quickly
            self._dc_estimate[channel_idx] = (
                (1.0 - alpha_dc) * dc + alpha_dc * chunk_mean
            )
        data -= self._dc_estimate[channel_idx]

        return data

    def denoise_block(
        self, data: np.ndarray, channel_idx: int = 0
    ) -> np.ndarray:
        """
        Block denoising + adaptive scaling on the visible plot window.

        Pipeline per frame:
          5. Linear detrend
          6. Wavelet denoise  (BayesShrink + MAD)
          7. Adaptive scaling  (keep within ±target_uv)

        Args:
            data: 1-D numpy array of IIR-filtered µV values.
            channel_idx: channel index for per-channel amplitude tracking.

        Returns:
            Denoised, range-normalised 1-D numpy array (±target_uv).
        """
        if len(data) < 8:
            return data

        # 5. Linear detrend
        data = signal.detrend(data, type="linear")

        # 6. Wavelet denoise (BayesShrink with median-rule noise estimate)
        if _HAS_PYWT and len(data) >= 16:
            data = self._wavelet_denoise(data)

        # 7. Adaptive robust scaling — guarantees ±target_uv output.
        #    Uses a smoothed 99th-percentile amplitude estimate so the
        #    gain changes gradually (no jitter).  Only scales DOWN; if the
        #    signal is already within range it passes through untouched.
        if channel_idx >= len(self._amp_estimate):
            self._amp_estimate.extend(
                [None] * (channel_idx + 1 - len(self._amp_estimate))
            )

        p99 = float(np.percentile(np.abs(data), 99))
        p99 = max(p99, 1e-3)  # floor to avoid div-by-zero

        amp = self._amp_estimate[channel_idx]
        if amp is None:
            self._amp_estimate[channel_idx] = p99
        else:
            ema = 0.08  # moderate adaptation — stable but responsive
            self._amp_estimate[channel_idx] = (1.0 - ema) * amp + ema * p99

        amp = self._amp_estimate[channel_idx]
        if amp > self._target_uv:
            data = data * (self._target_uv / amp)

        return np.clip(data, -self._target_uv, self._target_uv)


# ===================== ARTIFACT REMOVAL =====================


class ArtifactRemover:
    """
    Artifact detection and removal
    """

    def __init__(self):
        self.cfg = CONFIG["artifact"]
        self.fs = CONFIG["adc"]["sample_rate"]

        # logger.info("Artifact Remover initialized:")
        # logger.info(
        #     f"  Amplitude: percentile={self.cfg['amplitude_percentile']}, mult={self.cfg['amplitude_multiplier']}"
        # )
        # logger.info(
        #     f"  Gradient: percentile={self.cfg['gradient_percentile']}, mult={self.cfg['gradient_multiplier']}"
        # )
        # logger.info(f"  Z-score threshold: {self.cfg['zscore_threshold']}")
        # logger.info(f"  Max interpolation: {self.cfg['max_interpolation_pct']}%")

    def remove(self, data):
        """
        Detect and remove artifacts
        """
        # logger.debug(f"Artifact removal on {data.shape} samples...")

        data = data.copy()
        if data.ndim == 1:
            data = data.reshape(-1, 1)

        n_samples, n_channels = data.shape
        mask = np.zeros_like(data, dtype=bool)

        for ch in range(n_channels):
            ch_data = data[:, ch]
            ch_artifacts = 0

            # 1. Amplitude threshold
            if self.cfg.get("amplitude_enabled", True):
                thresh = (
                    np.percentile(np.abs(ch_data), self.cfg["amplitude_percentile"])
                    * self.cfg["amplitude_multiplier"]
                )
                amp_mask = np.abs(ch_data) > thresh
                mask[:, ch] |= amp_mask
                ch_artifacts += np.sum(amp_mask)

            # 2. Gradient threshold
            if self.cfg.get("gradient_enabled", True):
                grad = np.abs(np.diff(ch_data, prepend=ch_data[0]))
                grad_thresh = (
                    np.percentile(grad, self.cfg["gradient_percentile"])
                    * self.cfg["gradient_multiplier"]
                )
                grad_mask = grad > grad_thresh
                mask[:, ch] |= grad_mask
                ch_artifacts += np.sum(grad_mask)

            # 3. Flatline detection
            if self.cfg.get("flatline_enabled", True):
                flatline_samples = int(self.cfg["flatline_min_duration_sec"] * self.fs)
                if n_samples >= flatline_samples:
                    for i in range(n_samples - flatline_samples):
                        window = ch_data[i : i + flatline_samples]
                        if np.std(window) < self.cfg["flatline_std_threshold_uv"]:
                            mask[i : i + flatline_samples, ch] = True

            # 4. Z-score threshold
            if self.cfg.get("zscore_enabled", True):
                z = (ch_data - np.mean(ch_data)) / (np.std(ch_data) + 1e-10)
                z_mask = np.abs(z) > self.cfg["zscore_threshold"]
                mask[:, ch] |= z_mask
                ch_artifacts += np.sum(z_mask)

            if ch_artifacts > 0:
                logger.debug(f"  Channel {ch}: {ch_artifacts} artifacts detected")

        # Check if too many samples are bad
        total_bad_pct = np.mean(mask) * 100
        max_interpolation_pct = self.cfg.get("max_interpolation_pct", 30.0)

        if total_bad_pct > max_interpolation_pct:
            artifact_pct = (np.mean(mask, axis=0) * 100).tolist()
            return data, artifact_pct

        # Interpolate bad samples
        interpolation_method = self.cfg.get("interpolation_method", "linear")
        for ch in range(n_channels):
            bad = np.where(mask[:, ch])[0]
            good = np.where(~mask[:, ch])[0]
            if len(bad) > 0 and len(good) > 0:
                if interpolation_method == "linear":
                    data[bad, ch] = np.interp(bad, good, data[good, ch])

        artifact_pct = (np.mean(mask, axis=0) * 100).tolist()
        logger.debug(f"  Artifact percentages: {[f'{p:.2f}%' for p in artifact_pct]}")

        return data, artifact_pct


class SpectralAnalyzer:
    """
    Spectral analysis (Welch's method)
    """

    def __init__(self):
        self.fs = CONFIG["adc"]["sample_rate"]
        self.cfg = CONFIG["spectral"]
        self.bands = CONFIG["bands"]
        self.window_type = self.cfg.get("window_type", "hann")

        # logger.info("Spectral Analyzer initialized:")
        # logger.info(f"  Window: {self.cfg['window_sec']}s ({self.window_type})")
        # logger.info(f"  Overlap: {self.cfg['overlap_ratio'] * 100:.0f}%")
        # logger.info(f"  Bands: {list(self.bands.keys())}")

    def analyze(self, data):
        """
        Perform spectral analysis
        """
        if data.ndim > 1:
            # Average across channels for overall spectrum
            data = np.mean(data, axis=1)
            logger.debug(f"Averaged {data.shape[0]} channels for spectral analysis")

        nperseg = min(int(self.cfg["window_sec"] * self.fs), len(data))

        # Welch's method for power spectral density
        freqs, psd = signal.welch(
            data, fs=self.fs, nperseg=nperseg, window=self.window_type
        )

        freq_res = freqs[1] - freqs[0] if len(freqs) > 1 else 1.0
        total = simpson(psd, dx=freq_res)

        # Main bands
        absolute, relative = {}, {}
        for band, limits in self.bands.items():
            if band == "sub_bands":
                continue
            low, high = limits
            idx = (freqs >= low) & (freqs <= high)
            power = simpson(psd[idx], dx=freq_res) if np.any(idx) else 0.0
            absolute[band] = float(power)
            relative[band] = float(power / total) if total > 0 else 0.0

        # Sub-bands
        if "sub_bands" in self.bands:
            for sub_band, (low, high) in self.bands["sub_bands"].items():
                idx = (freqs >= low) & (freqs <= high)
                power = simpson(psd[idx], dx=freq_res) if np.any(idx) else 0.0
                absolute[sub_band] = float(power)
                relative[sub_band] = float(power / total) if total > 0 else 0.0

        dominant = max(relative, key=relative.get) if relative else "unknown"

        logger.debug(f"Spectral analysis complete. Dominant: {dominant}")

        return {
            "absolute": absolute,
            "relative": relative,
            "dominant_band": dominant,
        }


class CognitiveMetrics:
    """
    Cognitive metrics calculator
    """

    def __init__(self):
        self.cfg = CONFIG["metrics"]
        self.smoothing_enabled = self.cfg.get("smoothing_enabled", True)
        self.smoothing_alpha = self.cfg.get("smoothing_alpha", 0.3)

        # Initialize smoothed values
        self.smoothed_focus = None
        self.smoothed_stress = None
        self.smoothed_readiness = None
        self.smoothed_engagement = None
        self.smoothed_drowsiness = None

        # logger.info("Cognitive Metrics initialized:")
        # logger.info(
        #     f"  Smoothing: {'enabled' if self.smoothing_enabled else 'disabled'} (alpha={self.smoothing_alpha})"
        # )
        # logger.info(f"  Formulas: {self.cfg['focus_formula']}")

    def compute(self, bp: Dict[str, float]) -> Dict[str, float]:
        """
        Compute cognitive metrics from band powers
        """

        def ratio(n, d):
            return n / (d + 1e-10)

        def norm(v, r):
            normalized = (v - r[0]) / (r[1] - r[0]) * 100
            return float(np.clip(normalized, 0, 100))

        # Get band powers
        delta = bp.get("delta", 0.0)
        theta = bp.get("theta", 0.0)
        alpha = bp.get("alpha", 0.0)
        beta = bp.get("beta", 0.0)
        high_beta = bp.get("high_beta", beta * 0.6)

        #  formulas
        focus = ratio(beta, alpha + theta)
        stress = ratio(beta + high_beta, alpha)
        readiness = ratio(alpha, beta + high_beta)
        engagement = ratio(beta, alpha + theta)
        drowsiness = ratio(theta + delta, alpha + beta)

        logger.debug(
            f"Raw metrics: focus={focus:.3f}, stress={stress:.3f}, readiness={readiness:.3f}"
        )

        # Apply smoothing if enabled
        if self.smoothing_enabled:
            if self.smoothed_focus is None:
                self.smoothed_focus = focus
                self.smoothed_stress = stress
                self.smoothed_readiness = readiness
                self.smoothed_engagement = engagement
                self.smoothed_drowsiness = drowsiness
            else:
                self.smoothed_focus = (
                    self.smoothing_alpha * focus
                    + (1 - self.smoothing_alpha) * self.smoothed_focus
                )
                self.smoothed_stress = (
                    self.smoothing_alpha * stress
                    + (1 - self.smoothing_alpha) * self.smoothed_stress
                )
                self.smoothed_readiness = (
                    self.smoothing_alpha * readiness
                    + (1 - self.smoothing_alpha) * self.smoothed_readiness
                )
                self.smoothed_engagement = (
                    self.smoothing_alpha * engagement
                    + (1 - self.smoothing_alpha) * self.smoothed_engagement
                )
                self.smoothed_drowsiness = (
                    self.smoothing_alpha * drowsiness
                    + (1 - self.smoothing_alpha) * self.smoothed_drowsiness
                )

            focus = self.smoothed_focus
            stress = self.smoothed_stress
            readiness = self.smoothed_readiness
            engagement = self.smoothed_engagement
            drowsiness = self.smoothed_drowsiness

        # Normalize to 0-100
        focus_norm = norm(focus, self.cfg["focus_typical_range"])
        stress_norm = norm(stress, self.cfg["stress_typical_range"])
        readiness_norm = norm(readiness, self.cfg["readiness_typical_range"])
        engagement_norm = norm(engagement, self.cfg["engagement_typical_range"])
        drowsiness_norm = norm(drowsiness, self.cfg["drowsiness_typical_range"])

        return {
            "focus": round(focus_norm, 1),
            "stress": round(stress_norm, 1),
            "mental_readiness": round(readiness_norm, 1),
            "engagement": round(engagement_norm, 1),
            "drowsiness": round(drowsiness_norm, 1),
        }


# ===================== SIGNAL PROCESSOR FOR STREAMING =====================


class SignalProcessor:
    """
    Signal processor for Zone SDK
 
    """

    def __init__(self):
        # logger.info("=" * 80)
        # logger.info("Initializing Signal Processor")
        # logger.info("=" * 80)

        self.converter = ADCConverter()
        self.eeg_filter = EEGFilter()
        self.artifact = ArtifactRemover()
        self.spectral = SpectralAnalyzer()

        # logger.info("Signal Processor ready")
        # logger.info("=" * 80)

    def process_streaming(self, raw_data: RawEEGData) -> BrainwaveData:
        """
        Process streaming data 

        Pipeline steps:
        1. Convert RAW ADC counts → µV
        2. Filter (detrend + bandpass + notch)
        3. Remove artifacts
        4. Spectral analysis (Welch's method)
        """
        logger.debug("\n" + "=" * 60)
        logger.debug("PROCESSING PIPELINE START")
        logger.debug("=" * 60)

        # Convert to numpy array
        if isinstance(raw_data.channels[0], list):
            channels = raw_data.channels
            n_channels = len(channels)
            min_len = min(len(ch) for ch in channels)

            data = np.zeros((min_len, n_channels))
            for ch_idx in range(n_channels):
                data[:min_len, ch_idx] = channels[ch_idx][:min_len]

            logger.debug(f"Input: {data.shape} samples from {n_channels} channels")
        else:
            data = np.array(raw_data.channels).reshape(-1, 1)
            logger.debug(f"Input: {data.shape} samples (single channel)")

        # Check if we have enough data
        min_samples = 500  # 2s window at 250 Hz
        if data.shape[0] < min_samples:
            logger.warning(f"Not enough samples ({data.shape[0]} < {min_samples})")
            return BrainwaveData(
                timestamp=datetime.now(),
                delta=0.0,
                theta=0.0,
                alpha=0.0,
                beta=0.0,
                gamma=0.0,
            )

        # STEP 1: Convert RAW counts → µV
        logger.debug("Step 1: ADC conversion (counts → µV)")
        data_uv = self.converter.convert(data)

        # STEP 2: Filter
        # logger.debug("Step 2: Filtering (detrend + bandpass + notch)")
        data_filt = self.eeg_filter.filter(data_uv)

        # STEP 3: Remove artifacts
        logger.debug("Step 3: Artifact removal")
        data_clean, artifact_pct = self.artifact.remove(data_filt)

        # STEP 4: Spectral analysis
        logger.debug("Step 4: Spectral analysis")
        spec = self.spectral.analyze(data_clean)

        logger.debug("=" * 60)
        logger.debug(f"RESULTS: Dominant={spec['dominant_band']}")
        for band in ["delta", "theta", "alpha", "beta", "gamma"]:
            logger.debug(f"  {band:8s}: {spec['relative'].get(band, 0.0):.4f}")
        logger.debug("=" * 60 + "\n")

        return BrainwaveData(
            timestamp=datetime.now(),
            delta=spec["relative"].get("delta", 0.0),
            theta=spec["relative"].get("theta", 0.0),
            alpha=spec["relative"].get("alpha", 0.0),
            beta=spec["relative"].get("beta", 0.0),
            gamma=spec["relative"].get("gamma", 0.0),
        )


class MetricsCalculator:
    """
    Metrics calculator for Zone SDK
    """

    def __init__(self):
        # logger.info("Metrics Calculator initialized")
        self._metrics_calc = CognitiveMetrics()

    def calculate_metrics(self, bw: BrainwaveData) -> MetricsData:
        """Calculate cognitive metrics from brainwave data"""
        bp = {
            "delta": bw.delta,
            "theta": bw.theta,
            "alpha": bw.alpha,
            "beta": bw.beta,
            "gamma": bw.gamma,
        }

        # Compute  formulas
        raw_metrics = self._metrics_calc.compute(bp)

        # Convert from 0-100 to 0-1 for SDK compatibility
        focus = raw_metrics["focus"] / 100.0
        stress = raw_metrics["stress"] / 100.0
        readiness = raw_metrics["mental_readiness"] / 100.0
        engagement = raw_metrics["engagement"] / 100.0
        drowsiness = raw_metrics["drowsiness"] / 100.0

        # Derived metrics 
        relaxation = max(0.0, min(1.0, 1.0 - stress))
        wellness = max(0.0, min(1.0, (focus + readiness) / 2.0))

        return MetricsData(
            timestamp=datetime.now(),
            focus=focus,
            stress=stress,
            mental_readiness=readiness,
            engagement=engagement,
            drowsiness=drowsiness,
            relaxation=relaxation,
            wellness=wellness,
        )
