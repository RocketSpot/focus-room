"""Zone, The Focus Room: the room's own spectral analysis.

WHY THIS MODULE EXISTS
----------------------
The vendored SDK reports each band as a share of total power. On real EEG that
statistic is broken by physics, not by noise. EEG carries a 1/f^x aperiodic
background, so the band nearest DC always holds most of the power. Measured on a
pure 1/f^1.3 spectrum with NO oscillation present at all:

    relative share   delta 32.8%  theta 25.4%  alpha 14.2%  beta 19.7%  gamma 7.9%
    oscillatory dB   delta +0.09  theta +0.21  alpha +0.19  beta +0.24  gamma +0.30

The left row is why an awake guest reading a book measured 77% delta. No filter
setting fixes it, because there is nothing wrong with the signal: the statistic
is simply measuring the shape of the background.

So this module reports OSCILLATORY PROMINENCE instead. It fits the guest's own
1/f background, then measures how far each band rises ABOVE that background, in
dB. A band with no rhythm in it reads ~0 dB no matter how much 1/f power sits
there. A band with a real rhythm reads its true height. Delta is measured, never
suppressed: feed it a genuine 3 Hz rhythm and it reports one.

WHAT THIS MODULE IS NOT
-----------------------
It never converts to microvolts. The ADC calibration chain is unverified, and
the reported quantity is a RATIO against the same guest's own background, so it
is independent of electrode impedance, contact area and ADC gain. That is a
feature: it is what lets the room report a number honestly without a calibration.

It never interpolates. There is no gap-filling code path here at all, and the
test suite asserts that by inspection.

Pure functions only. No I/O, no state, no logging. The stateful per-guest side
(ring buffers, artifact references, window scheduling) lives in band_analyzer.py.
"""

from __future__ import annotations

import numpy as np
from scipy import signal as _sig

# --- the analysis band -------------------------------------------------------
# Half-open [lo, hi) on every band. The SDK used (freqs >= lo) & (freqs <= hi),
# which counts the bins at 4, 8, 13 and 30 Hz into BOTH adjacent bands. That is
# not a partition, and it shows: 77 of 193 rows in the one real session have the
# five "shares" summing above 1.0, peaking at 1.1875. A partition of a total
# cannot exceed the total.
BANDS = {
    "delta": (2.0, 4.0),
    "theta": (4.0, 8.0),
    "alpha": (8.0, 13.0),
    "beta": (13.0, 30.0),
    "gamma": (30.0, 45.0),
}
BAND_ORDER = ("delta", "theta", "alpha", "beta", "gamma")

ANALYSIS_LO_HZ = 2.0
ANALYSIS_HI_HZ = 45.0

# The measured band starts at 2 Hz as a STATED SCOPE LIMIT, not as suppression.
# Below 2 Hz an in-ear montage on a guest who is allowed to move is dominated by
# electrode and motion potentials that no stationary spectral model can separate
# from brain activity. The room would rather measure a narrower range honestly
# than a wider one it cannot defend.
#
# Note the difference from the previous attempt: the band-pass corner now sits
# 1.5 Hz BELOW the lowest measured bin, so no band edge rides a filter skirt.
# The old config high-passed at 2.0 Hz and then measured delta from 2.0 Hz, so
# its delta suppression came from partially filtering out the band it was
# measuring (power gain 0.250 at 2.0 Hz). It also destroyed the top of gamma
# (0.250 at 40 Hz, 0.018 at 45 Hz), which is why gamma read 1.34%.
FILTER_LO_HZ = 0.5
FILTER_HI_HZ = 90.0
FILTER_ORDER = 4

LINE_HZ = (50.0, 60.0)          # notched; both sit outside gamma and outside the fit range
LINE_Q = 45.0                   # ~1.1 Hz wide. Q=30 was costing 6% of the power at
                                # 45 Hz, the very top of gamma; at 45 that dip is 2.7%.
                                # Mains is frequency-stable, so a narrow notch is both
                                # sufficient and cheaper to the band above it.

# --- Welch ------------------------------------------------------------------
# nperseg 500 at 250 Hz is a 2.0 s segment, so 0.5 Hz resolution. With a 6 s
# buffer and 75% overlap that is 9 segments per channel, 36 periodograms across
# four channels feeding the median. The SDK had nperseg == len(data), i.e. ONE
# segment: a raw periodogram with 2 degrees of freedom and a measured 56%
# coefficient of variation on the delta share. That alone would trip a 0.62
# threshold on clean data by chance.
NPERSEG = 500
NOVERLAP = 375

# --- aperiodic fit ----------------------------------------------------------
FIT_LO_HZ = 2.0
FIT_HI_HZ = 40.0                # below the 48-52 and 58-62 notch regions
K_POS = 1.5                     # peak exclusion, in robust SDs above the fit
K_NEG = 4.0                     # only pathological dropouts excluded below it
MAX_ITERS = 3
MIN_RETAINED_FRAC = 0.35
MIN_R2 = 0.90
CHI_LIMITS = (0.0, 3.5)

_EPS = 1e-30


def _as_2d(channels) -> np.ndarray:
    """channels -> (n_channels, n_samples) float array."""
    a = np.asarray(channels, dtype=np.float64)
    if a.ndim == 1:
        a = a[None, :]
    return a


def analysis_filter(x: np.ndarray, fs: float = 250.0) -> np.ndarray:
    """Detrend, band-pass and notch ONE channel, zero-phase.

    Zero-phase (filtfilt) is correct here because this is an offline-style
    analysis of a completed window, not a live display trace. The display path
    in tv-signal.html uses causal filters instead, deliberately.

    The band-pass is flat (power gain 1.000) at 2, 4, 8, 13, 30 and 45 Hz, so no
    band edge sits on a skirt.
    """
    x = np.asarray(x, dtype=np.float64)
    x = _sig.detrend(x, type="linear")
    sos = _sig.butter(FILTER_ORDER, [FILTER_LO_HZ, FILTER_HI_HZ], btype="band",
                      fs=fs, output="sos")
    y = _sig.sosfiltfilt(sos, x)
    for f0 in LINE_HZ:
        if f0 < fs / 2.0:
            b, a = _sig.iirnotch(f0, LINE_Q, fs=fs)
            y = _sig.filtfilt(b, a, y)
    return y


def welch_per_channel(channels, fs: float = 250.0, nperseg: int = NPERSEG,
                      noverlap: int = NOVERLAP, prefiltered: bool = False):
    """Per-channel PSD. Returns (freqs, psd_stack) with psd_stack (n_ch, n_freq).

    Each channel is filtered and transformed SEPARATELY. The SDK averaged the
    four channels in the TIME domain before its PSD (processors.py:611), which
    is the single largest amplifier of the delta problem: drift is common-mode
    across the electrodes so it adds coherently (16x power for four channels)
    while genuine rhythms at the two ears are only partly correlated (4x power).

    It is also invalid in principle here, not merely noisy: the two buds unwrap
    their 8-bit sample counters independently, so after any packet loss on one
    bud, sample i on the left is not simultaneous with sample i on the right.
    Time-domain averaging assumes an alignment that does not exist.
    """
    data = _as_2d(channels)
    n = data.shape[1]
    nps = int(min(nperseg, n))
    nov = int(min(noverlap, max(0, nps - 1)))
    out = []
    for ch in data:
        y = ch if prefiltered else analysis_filter(ch, fs)
        f, p = _sig.welch(y, fs=fs, nperseg=nps, noverlap=nov, window="hann")
        out.append(p)
    return f, np.vstack(out)


def combine_median(psd_stack: np.ndarray) -> np.ndarray:
    """Combine channels per frequency bin, in the POWER domain, by median.

    Median rather than mean because the failure mode that matters is ONE
    electrode popping. Measured drift-power to alpha-power ratio with a single
    channel carrying a 400-count excursion:

        clean single-channel reference        1.72
        time-domain mean (the SDK's method)   1856.89
        mean of the per-channel PSDs          1737.65
        median of the per-channel PSDs        2.20

    A mean in the power domain barely helps; the median rejects it outright.
    """
    stack = np.atleast_2d(psd_stack)
    return np.median(stack, axis=0)


def band_masks(freqs: np.ndarray):
    """Half-open masks, a true partition of [2, 45)."""
    return {k: (freqs >= lo) & (freqs < hi) for k, (lo, hi) in BANDS.items()}


def band_powers(freqs: np.ndarray, psd: np.ndarray):
    """Integrate each band by rectangular sum. Deliberately NOT Simpson's rule.

    The SDK used scipy.integrate.simpson over a masked subarray with dx=. On a
    discrete PSD, whose bins are already an integral over their own width, that
    applies 1/3-4/3-2/3 weights to values that should be summed flat, and with
    an even bin count it silently switches to an asymmetric rule. A rectangular
    sum is the correct estimator here, not a cruder one.
    """
    df = float(freqs[1] - freqs[0]) if len(freqs) > 1 else 1.0
    masks = band_masks(freqs)
    return {k: float(psd[m].sum() * df) for k, m in masks.items()}


def fit_aperiodic(freqs: np.ndarray, psd: np.ndarray,
                  f_lo: float = FIT_LO_HZ, f_hi: float = FIT_HI_HZ,
                  k_pos: float = K_POS, k_neg: float = K_NEG,
                  iters: int = MAX_ITERS, chi_fixed=None):
    """Fit the 1/f background: log10 P(f) = b - chi * log10 f.

    This is specparam's algorithm (initial fit, residual-based peak exclusion,
    refit on the peak-removed spectrum) implemented compactly in-repo rather
    than adding the dependency. The sidecar is PyInstaller-frozen for Windows
    and every added package is a packaging risk, and we need only the aperiodic
    floor, not the peak centre/bandwidth/height machinery.

    No knee term. A knee is not identifiable over 2 to 40 Hz, and specparam's
    own guidance is a fixed exponent for restricted ranges.

    TWO DELIBERATE CHOICES, both load-bearing:

    1. Weight each bin by 1/f, which is uniform weight per octave. Linear-spaced
       FFT bins put 76 bins in 20-40 Hz and only 4 in 2-4 Hz, so an unweighted
       log-log fit is dominated by beta and gamma and mis-estimates the floor in
       exactly the place delta and theta live.

    2. Exclude peaks ASYMMETRICALLY. Oscillations are POSITIVE departures from
       the floor, so this is a lower-envelope fit: k_pos is tight (1.5 SD) while
       k_neg is loose (4.0 SD) and only catches pathological dropouts. That is
       what keeps the fit unbiased when a large alpha is present.

    Returns (b, chi, r2, retained_frac, ok).
    """
    m = (freqs >= f_lo) & (freqs <= f_hi)
    f = freqs[m]
    if f.size < 8:
        return (0.0, 0.0, 0.0, 0.0, False)
    p = np.log10(np.maximum(psd[m], _EPS))
    lf = np.log10(f)
    w = 1.0 / f                                     # uniform weight per octave
    keep = np.ones(f.size, dtype=bool)
    A = np.vstack([np.ones_like(lf), -lf]).T

    b = float(p.mean())
    chi = 0.0 if chi_fixed is None else float(chi_fixed)

    for _ in range(max(1, iters)):
        wk = w * keep
        if wk.sum() <= 0:
            break
        if chi_fixed is None:
            WA = A * wk[:, None]
            try:
                sol = np.linalg.lstsq(WA.T @ A, WA.T @ p, rcond=None)[0]
            except np.linalg.LinAlgError:
                return (0.0, 0.0, 0.0, 0.0, False)
            b, chi = float(sol[0]), float(sol[1])
        else:
            # rung two of the failure ladder: chi is a slow-varying property of
            # the person and the montage, while the offset moves with contact.
            # Hold chi and solve only for b, as a weighted median so a residual
            # peak cannot drag it.
            chi = float(chi_fixed)
            resid = p + chi * lf
            b = float(_weighted_median(resid[keep], wk[keep]))
        r = p - (b - chi * lf)
        rk = r[keep]
        if rk.size < 4:
            break
        s = 1.4826 * float(np.median(np.abs(rk - np.median(rk))))
        if not np.isfinite(s) or s <= 0:
            break
        fresh = (r < k_pos * s) & (r > -k_neg * s)
        ex = ~fresh
        # guard one bin either side, so a peak's shoulders do not pull the floor up
        ex = ex | np.roll(ex, 1) | np.roll(ex, -1)
        fresh = ~ex
        if fresh.sum() < MIN_RETAINED_FRAC * f.size or np.array_equal(fresh, keep):
            break
        keep = fresh

    model = b - chi * lf
    wk = w * keep
    if wk.sum() <= 0:
        return (b, chi, 0.0, 0.0, False)
    mu = float(np.average(p[keep], weights=wk[keep]))
    ss_res = float(np.sum(wk[keep] * (p[keep] - model[keep]) ** 2))
    ss_tot = float(np.sum(wk[keep] * (p[keep] - mu) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    retained = float(keep.mean())
    ok = bool(r2 >= MIN_R2 and retained >= MIN_RETAINED_FRAC
              and CHI_LIMITS[0] <= chi <= CHI_LIMITS[1] and np.isfinite(b))
    return (b, chi, r2, retained, ok)


def _weighted_median(v: np.ndarray, w: np.ndarray) -> float:
    if v.size == 0:
        return 0.0
    order = np.argsort(v)
    v, w = v[order], w[order]
    c = np.cumsum(w)
    if c[-1] <= 0:
        return float(np.median(v))
    return float(v[np.searchsorted(c, 0.5 * c[-1])])


def aperiodic_psd(freqs: np.ndarray, b: float, chi: float) -> np.ndarray:
    """The fitted background evaluated on the frequency grid."""
    f = np.maximum(np.asarray(freqs, dtype=np.float64), _EPS)
    return np.power(10.0, b) * np.power(f, -chi)


def oscillatory_db(freqs: np.ndarray, psd: np.ndarray, b: float, chi: float):
    """How far each band rises above THIS guest's own 1/f background, in dB.

        OSC_B = 10 * log10( mean_{f in B} P(f) / mean_{f in B} A(f) )

    Why dB above the fitted floor is the right quantity to report:

      - Scale invariant. It does not depend on b, so it is independent of
        electrode impedance, contact area and ADC gain, and therefore of the
        whole unverified calibration chain.
      - Not zero-sum. Unlike a share, one band being large does not mechanically
        crush the other four, so every band is free to move and the notification
        always has something true to report.
      - Zero when there is no rhythm, whatever the background looks like.
    """
    ap = aperiodic_psd(freqs, b, chi)
    masks = band_masks(freqs)
    out = {}
    for k, m in masks.items():
        if not np.any(m):
            out[k] = 0.0
            continue
        num = float(np.mean(psd[m]))
        den = float(np.mean(ap[m]))
        out[k] = 10.0 * np.log10(max(num, _EPS) / max(den, _EPS))
    return out


def total_share(powers: dict) -> dict:
    """The CORRECT share of total band power, half-open and summing to 1.0.

    Emitted only so the existing chart, the operator console and the room audio
    keep working unchanged. No guest-facing number is ever built from it, for
    all the reasons at the top of this file.
    """
    tot = sum(max(0.0, powers.get(k, 0.0)) for k in BAND_ORDER)
    if tot <= 0:
        return {k: 0.0 for k in BAND_ORDER}
    return {k: max(0.0, powers.get(k, 0.0)) / tot for k in BAND_ORDER}


def analyse_window(channels, fs: float = 250.0, chi_prior=None,
                   nperseg: int = NPERSEG, noverlap: int = NOVERLAP,
                   prefiltered: bool = False):
    """One accepted window of accepted channels, start to finish.

    `channels` is already artifact-screened by band_analyzer; this function does
    not decide what is usable, it only measures what it is handed.

    Implements the three-rung fit-failure ladder:
      1. full two-parameter robust fit,
      2. if that fails the quality gate, refit with chi held at the session's
         running median and solve only the offset,
      3. if there is no prior chi either, return ok=False so the caller DROPS
         the window. It never falls back to relative shares, because that would
         quietly reintroduce the exact bug this module exists to remove.
    """
    freqs, stack = welch_per_channel(channels, fs=fs, nperseg=nperseg,
                                     noverlap=noverlap, prefiltered=prefiltered)
    psd = combine_median(stack)

    b, chi, r2, retained, ok = fit_aperiodic(freqs, psd)
    mode = "fit"
    if not ok and chi_prior is not None:
        b, chi, r2, retained, ok2 = fit_aperiodic(freqs, psd, chi_fixed=float(chi_prior))
        mode = "fixed-exponent"
        ok = bool(np.isfinite(b))
    elif not ok:
        mode = "failed"

    powers = band_powers(freqs, psd)
    result = {
        "ok": bool(ok),
        "freqs": freqs,
        "psd": psd,
        "powers": powers,
        "share": total_share(powers),
        "aperiodic": {"offsetLog10": float(b), "exponent": float(chi),
                      "r2": float(r2), "retainedFrac": float(retained),
                      "mode": mode, "ok": bool(ok)},
        "channelsUsed": int(np.atleast_2d(stack).shape[0]),
    }
    result["osc"] = oscillatory_db(freqs, psd, b, chi) if ok else {k: 0.0 for k in BAND_ORDER}
    return result
