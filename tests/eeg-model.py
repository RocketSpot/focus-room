"""Shared EEG signal models for the DSP tests. NOT a test itself.

WHY THIS FILE EXISTS
--------------------
The test this replaces built its "EEG" from `6.0 * rng.standard_normal(N)`.
That is white noise, spectral exponent 0. Real EEG has an exponent around 1 to
1.5, and that difference is the whole ballgame: measured through the very same
code path, a white background gives delta 2.3% and alpha 81.4%, while a plain
1/f^1.5 background with NO rhythms at all gives delta 33.8%. The old test passed
because it was testing against a signal that does not occur in nature.

Its oscillations were also infinitely narrow sinusoids, so all their power fell
in one or two FFT bins. A real 10 Hz rhythm is a broad bump several Hz wide, and
a peak-exclusion rule tuned on pure tones will not survive contact with one.

Everything here is in ADC COUNTS. Nothing in this file, or anything that reads
it, ever claims a microvolt: the room's calibration is deliberately unverified.
`alpha_units` below is an amplitude in counts chosen to sit in the same ratio to
the background that a few microvolts of ear alpha would.
"""

from __future__ import annotations

import numpy as np
from scipy import signal as _sig

FS = 250.0


def pink(n, chi=1.3, rng=None, fs=FS):
    """Exact 1/f^chi noise by spectral shaping, unit RMS.

    Built in the frequency domain so the exponent is exact by construction and
    the tests are measuring the analyser, not the generator.
    """
    rng = rng or np.random.default_rng(0)
    f = np.fft.rfftfreq(n, d=1.0 / fs)
    amp = np.zeros_like(f)
    amp[1:] = f[1:] ** (-chi / 2.0)          # amplitude, hence chi/2 for power
    ph = rng.uniform(0, 2 * np.pi, size=f.size)
    spec = amp * np.exp(1j * ph)
    spec[0] = 0.0
    x = np.fft.irfft(spec, n=n)
    s = x.std()
    return x / s if s > 0 else x


def bump(n, fc=10.0, bw=3.0, amp=1.0, rng=None, fs=FS):
    """A BROAD oscillation: band-pass filtered noise, not a sinusoid.

    This is what a real rhythm looks like on a spectrum, a hill rather than a
    spike, and it is the honest thing to tune peak exclusion against.
    """
    rng = rng or np.random.default_rng(1)
    lo, hi = max(0.1, fc - bw / 2.0), min(fs / 2.0 - 0.1, fc + bw / 2.0)
    sos = _sig.butter(4, [lo, hi], btype="band", fs=fs, output="sos")
    y = _sig.sosfiltfilt(sos, rng.standard_normal(n))
    s = y.std()
    return (y / s) * amp if s > 0 else y


def common_mode_drift(n, amp=1.0, rng=None, fs=FS):
    """Low-frequency drift, to be added IDENTICALLY to every channel.

    Electrode and motion potentials are common-mode across the electrodes. That
    is precisely why averaging the channels in the time domain is so damaging
    and why the median across per-channel spectra is not.
    """
    rng = rng or np.random.default_rng(2)
    sos = _sig.butter(2, 1.2, btype="low", fs=fs, output="sos")
    y = _sig.sosfiltfilt(sos, rng.standard_normal(n))
    s = y.std()
    return (y / s) * amp if s > 0 else y


def ear_eeg(n, chi=1.3, background=30.0, alpha_units=8.0, beta_units=4.0,
            theta_units=4.0, drift_units=0.0, n_channels=4, rng=None, fs=FS):
    """A realistic awake ear-EEG window, as (n_channels, n) ADC counts.

    Rhythms are drawn INDEPENDENTLY per channel while the drift is shared,
    matching the physical situation: the two buds sit on different heads-worth
    of cortex and are not even sample-aligned with each other, whereas motion
    and contact potentials move all four electrodes together.

    Default amplitudes put alpha well below the background, which is the honest
    regime for an ear montage. Alpha at the ear is small; a test that makes it
    dominant is not testing anything hard.
    """
    rng = rng or np.random.default_rng(3)
    shared = common_mode_drift(n, drift_units, rng=rng, fs=fs) if drift_units > 0 else 0.0
    out = []
    for c in range(n_channels):
        x = background * pink(n, chi, rng=np.random.default_rng(100 + c), fs=fs)
        if alpha_units > 0:
            x = x + bump(n, 10.0, 3.0, alpha_units, rng=np.random.default_rng(200 + c), fs=fs)
        if beta_units > 0:
            x = x + bump(n, 18.0, 6.0, beta_units, rng=np.random.default_rng(300 + c), fs=fs)
        if theta_units > 0:
            x = x + bump(n, 6.0, 2.5, theta_units, rng=np.random.default_rng(400 + c), fs=fs)
        out.append(x + shared)
    return np.vstack(out)


def legacy_relative_shares(channels, fs=FS):
    """Reproduce the OLD statistic, for use as a regression witness.

    Time-domain channel mean, single-segment periodogram, inclusive band edges,
    renormalised over the five bands. Kept here so the tests can assert, on the
    identical input, that the old number was large and the new one is not.
    """
    data = np.atleast_2d(np.asarray(channels, dtype=np.float64))
    x = np.mean(data, axis=0)                     # the SDK's processors.py:611
    f, p = _sig.welch(x, fs=fs, nperseg=len(x), window="hann")
    edges = {"delta": (2.0, 4.0), "theta": (4.0, 8.0), "alpha": (8.0, 13.0),
             "beta": (13.0, 30.0), "gamma": (30.0, 45.0)}
    df = f[1] - f[0] if len(f) > 1 else 1.0
    raw = {}
    for k, (lo, hi) in edges.items():
        m = (f >= lo) & (f <= hi)                 # inclusive both ends, as the SDK had it
        raw[k] = float(p[m].sum() * df)
    tot = sum(raw.values()) or 1e-30
    return {k: v / tot for k, v in raw.items()}
