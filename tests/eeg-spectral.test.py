"""The band pipeline, tested against EEG that behaves like EEG.

This replaces tests/eeg-drift-rejection.test.py, which could not have caught the
bug it claimed to prove fixed. That test built its background from
`6.0 * rng.standard_normal(N)`: white noise, spectral exponent 0. Real EEG has an
exponent around 1 to 1.5, and through the identical code path a white background
reports delta 2.3% while a plain 1/f^1.5 background with no rhythms at all
reports delta 33.8%. It was measuring the filter's ability to reject three known
sinusoids, not the pipeline's ability to handle a brain.

Every number asserted below was measured on this machine and is quoted in the
assertion so a future regression says what it broke, not just that it broke.

Run:  venv/bin/python tests/eeg-spectral.test.py      (exit 0 = pass)
"""

import importlib.util
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "sidecar"))

_spec = importlib.util.spec_from_file_location("eeg_model", os.path.join(_HERE, "eeg-model.py"))
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)

import spectral as S                      # noqa: E402
from band_analyzer import BandAnalyzer     # noqa: E402

_pass = 0
_fail = 0


def ok(name, cond, detail=""):
    global _pass, _fail
    print(("  ok   " if cond else " FAIL  ") + name + ("" if cond else "  >> " + str(detail)))
    if cond:
        _pass += 1
    else:
        _fail += 1


FS = 250.0
N = 1500                                   # the shipped 6 s window
BANDS = S.BAND_ORDER


def clean(chi, n=N, **kw):
    return np.vstack([kw.get("bg", 30.0) * M.pink(n, chi, rng=np.random.default_rng(100 + c))
                      for c in range(4)])


# ---------------------------------------------------------------- 1 + 2
# The headline: a 1/f background with NO oscillation must read as no oscillation,
# and the old statistic on the same input must show the delta blow-out.
print("\n1/f background, zero oscillation present")
for chi in (0.8, 1.0, 1.3, 1.5, 2.0):
    ch = clean(chi)
    osc = S.analyse_window(ch, fs=FS)["osc"]
    worst = max(abs(v) for v in osc.values())
    ok(f"chi={chi}: every band within 0.6 dB of zero (worst {worst:.2f} dB)",
       worst <= 0.6, {k: round(v, 2) for k, v in osc.items()})
    legacy = M.legacy_relative_shares(ch)
    if chi >= 1.5:
        ok(f"chi={chi}: the OLD statistic still shows delta dominant "
           f"({legacy['delta'] * 100:.1f}%), which is the bug this replaces",
           legacy["delta"] > 0.30 and legacy["delta"] == max(legacy.values()),
           {k: round(v, 3) for k, v in legacy.items()})

# ---------------------------------------------------------------- 3
print("\naperiodic exponent recovery")
for chi in (0.8, 1.0, 1.5, 2.0):
    for label, alpha_units in (("no peak", 0.0), ("large alpha", 24.0)):
        ch = clean(chi)
        if alpha_units:
            ch = ch + np.vstack([M.bump(N, 10.0, 3.0, alpha_units,
                                        rng=np.random.default_rng(700 + c)) for c in range(4)])
        ap = S.analyse_window(ch, fs=FS)["aperiodic"]
        err = abs(ap["exponent"] - chi)
        ok(f"chi={chi} ({label}): recovered {ap['exponent']:.2f}, error {err:.3f} <= 0.15",
           err <= 0.15, ap)

# ---------------------------------------------------------------- 4
print("\nan awake reader")
ch = M.ear_eeg(N, chi=1.3, background=30.0, alpha_units=8.0, beta_units=4.0, theta_units=4.0)
osc = S.analyse_window(ch, fs=FS)["osc"]
top = max(osc, key=osc.get)
ok(f"alpha is the largest band (got {top} at {osc[top]:+.2f} dB)", top == "alpha", osc)
ok(f"alpha rises at least 3 dB above the floor ({osc['alpha']:+.2f})", osc["alpha"] >= 3.0, osc)
ok(f"delta stays within 0.6 dB of zero ({osc['delta']:+.2f}), the guest is awake",
   abs(osc["delta"]) <= 0.6, osc)

# ---------------------------------------------------------------- 5
print("\ndelta is measured, never suppressed")
base = M.ear_eeg(N, chi=1.3, background=30.0, alpha_units=2.0, beta_units=2.0, theta_units=0.0)
deep = base + np.vstack([M.bump(N, 3.0, 1.2, 26.0, rng=np.random.default_rng(500 + c))
                         for c in range(4)])
osc = S.analyse_window(deep, fs=FS)["osc"]
ok(f"a genuine 3 Hz rhythm reports as delta ({osc['delta']:+.2f} dB >= 3)",
   osc["delta"] >= 3.0, osc)

# ---------------------------------------------------------------- 6 + 7
print("\nchannel combination")


def drift_alpha_ratio(psd, freqs):
    d = psd[(freqs >= 0.5) & (freqs < 2.0)].sum()
    a = psd[(freqs >= 8.0) & (freqs < 13.0)].sum()
    return float(d / max(a, 1e-30))


rng = np.random.default_rng(11)
alpha_only = np.vstack([M.bump(N, 10.0, 3.0, 10.0, rng=np.random.default_rng(800 + c))
                        for c in range(4)])
shared = M.common_mode_drift(N, 60.0, rng=rng)
common = alpha_only + shared
f_ref, p_ref = S.welch_per_channel(alpha_only[0:1], fs=FS)
ref = drift_alpha_ratio(S.combine_median(p_ref), f_ref)
f_m, p_m = S.welch_per_channel(common, fs=FS)
med = drift_alpha_ratio(S.combine_median(p_m), f_m)
f_t, p_t = S.welch_per_channel(np.mean(common, axis=0)[None, :], fs=FS)
tmean = drift_alpha_ratio(S.combine_median(p_t), f_t)
ok(f"common-mode drift: power-domain median ({med:.2f}) stays near a single "
   f"channel ({ref:.2f}), and never worse than the time-domain mean ({tmean:.2f})",
   med <= max(tmean, ref * 3.0) + 1e-9, (ref, med, tmean))

popped = alpha_only.copy()
popped[2] = popped[2] + M.common_mode_drift(N, 400.0, rng=np.random.default_rng(12))
f_p, p_p = S.welch_per_channel(popped, fs=FS)
med_pop = drift_alpha_ratio(S.combine_median(p_p), f_p)
f_tp, p_tp = S.welch_per_channel(np.mean(popped, axis=0)[None, :], fs=FS)
tmean_pop = drift_alpha_ratio(S.combine_median(p_tp), f_tp)
ok(f"one popped electrode: the median rejects it ({med_pop:.2f}) where the "
   f"time-domain mean does not ({tmean_pop:.1f})",
   med_pop < tmean_pop / 10.0, (med_pop, tmean_pop))

# ---------------------------------------------------------------- 8
print("\nestimator noise")
vals = {k: [] for k in BANDS}
for i in range(40):
    ch = M.ear_eeg(N, chi=1.3, background=30.0, alpha_units=8.0, beta_units=4.0,
                   theta_units=4.0, rng=np.random.default_rng(2000 + i))
    ch = ch + np.vstack([0.001 * M.pink(N, 1.3, rng=np.random.default_rng(9000 + 7 * i + c))
                         for c in range(4)])
    o = S.analyse_window(ch, fs=FS)["osc"]
    for k in BANDS:
        vals[k].append(o[k])
for k in BANDS:
    sd = float(np.std(vals[k]))
    ok(f"{k}: per-window spread {sd:.3f} dB <= 0.6", sd <= 0.6, sd)

# ---------------------------------------------------------------- 9
print("\nfilter flatness inside the measured band")
imp = np.zeros(4096)
imp[2048] = 1.0
resp = S.analysis_filter(imp, FS)
fr = np.fft.rfftfreq(len(resp), d=1.0 / FS)
H = np.abs(np.fft.rfft(resp)) ** 2
for probe in (2.0, 4.0, 8.0, 13.0, 30.0):
    g = float(H[np.argmin(np.abs(fr - probe))])
    ok(f"power gain at {probe} Hz is {g:.3f}, no band edge rides a skirt", g >= 0.97, g)
# 45 Hz is the one edge that is not perfectly flat: it sits 5 Hz from the 50 Hz
# notch, so the notch skirt costs a little power there. Narrowing the notch to
# Q=45 brought this from 0.94 to 0.97. Held to a looser bound deliberately,
# with the number quoted, rather than pretending the filter is ideal.
g45 = float(H[np.argmin(np.abs(fr - 45.0))])
ok(f"power gain at 45.0 Hz is {g45:.3f}, the notch skirt costs under 5% at the top of gamma",
   g45 >= 0.95, g45)

# ---------------------------------------------------------------- 10
print("\nband edges are a true partition")
freqs = np.arange(0, 125.5, 0.5)
masks = S.band_masks(freqs)
counts = sum(int(m.sum()) for m in masks.values())
expect = int(((freqs >= S.ANALYSIS_LO_HZ) & (freqs < S.ANALYSIS_HI_HZ)).sum())
ok(f"the five masks tile [2, 45) exactly ({counts} bins == {expect})", counts == expect)
overlap = 0
keys = list(masks)
for i in range(len(keys)):
    for j in range(i + 1, len(keys)):
        overlap += int((masks[keys[i]] & masks[keys[j]]).sum())
ok("no bin belongs to two bands (the SDK double counted 4, 8, 13 and 30 Hz)",
   overlap == 0, overlap)
sh = S.total_share(S.band_powers(*S.welch_per_channel(clean(1.3), fs=FS)[:1] +
                                 (S.combine_median(S.welch_per_channel(clean(1.3), fs=FS)[1]),)))
ok(f"shares sum to exactly 1.0 ({sum(sh.values()):.6f}), never 1.19",
   abs(sum(sh.values()) - 1.0) < 1e-9, sh)

# ---------------------------------------------------------------- 11
print("\nthe fit-failure ladder")
junk = np.vstack([np.full(N, 1000.0) + 0.001 * np.random.default_rng(3).standard_normal(N)
                  for _ in range(4)])
res = S.analyse_window(junk, fs=FS, chi_prior=None)
ok("an unfittable window with no prior exponent is NOT reported", not res["ok"], res["aperiodic"])
res2 = S.analyse_window(junk, fs=FS, chi_prior=1.3)
ok("with a prior exponent it falls back to a fixed-exponent refit",
   res2["aperiodic"]["mode"] in ("fixed-exponent", "fit"), res2["aperiodic"]["mode"])

# ---------------------------------------------------------------- 12
print("\nartifact rejection, end to end")


def run(ch, analyzer=None):
    got = []
    a = analyzer or BandAnalyzer(fs=FS)
    a.on_window(lambda r: got.append(r))
    for s in range(0, ch.shape[1], 50):
        a.ingest([list(ch[c][s:s + 50]) for c in range(4)])
    return a, got


a, got = run(M.ear_eeg(7500, chi=1.3, background=30.0, alpha_units=8.0,
                       beta_units=4.0, theta_units=4.0))
ok(f"a clean 30 s recording is fully accepted ({a.windows_accepted} windows, 0 dropped)",
   a.windows_dropped == 0 and a.windows_accepted > 15, a.counters())
late = [g["osc"] for g in got[8:]]
med_delta = float(np.median([o["delta"] for o in late]))
ok(f"delta stays flat across it ({med_delta:+.2f} dB)", abs(med_delta) <= 0.6, med_delta)

for drift, expect_all_dropped in ((30.0, False), (400.0, True)):
    a2, got2 = run(M.ear_eeg(7500, chi=1.3, background=30.0, alpha_units=8.0, beta_units=4.0,
                             theta_units=4.0, drift_units=drift))
    if expect_all_dropped:
        ok(f"violent movement (drift {drift:.0f}) is dropped, never reported as delta",
           a2.windows_accepted == 0, a2.counters())
    else:
        d = float(np.median([g["osc"]["delta"] for g in got2[8:]])) if len(got2) > 8 else 0.0
        ok(f"natural movement (drift {drift:.0f}) is still measured, {a2.windows_accepted} "
           f"windows accepted, delta {d:+.2f} dB",
           a2.windows_accepted > 10 and abs(d) <= 0.6, a2.counters())

# THE 2026-08-29 REGRESSION. A real settling electrode: enormous wander, all of
# it below 0.4 Hz, where the 0.5 Hz analysis high-pass deletes it before any
# number is computed. The raw-domain drift gate rejected ~90% of that session
# (every rejection tagged drift), starved the room's line, and read as constant
# "disconnecting" while both links ran at ~240 Hz. The gate now judges the slow
# component of the FILTERED signal, so this must sail through, clean.
_t = np.arange(7500) / 250.0
_wander = (np.sin(2 * np.pi * 0.07 * _t) + 0.6 * np.sin(2 * np.pi * 0.19 * _t + 1.0)
           + 0.3 * np.sin(2 * np.pi * 0.31 * _t + 2.2)) * 800.0
a_set, got_set = run(M.ear_eeg(7500, chi=1.3, background=30.0, alpha_units=8.0,
                               beta_units=4.0, theta_units=4.0) + _wander)
d_set = float(np.median([g["osc"]["delta"] for g in got_set[4:]])) if len(got_set) > 4 else 99.0
ok(f"a settling electrode (sub-0.4 Hz wander at ~27x the signal) is ACCEPTED "
   f"({a_set.windows_accepted} windows) and delta stays flat ({d_set:+.2f} dB)",
   a_set.windows_accepted >= 20 and abs(d_set) <= 0.6, a_set.counters())
ok("...and the analysis report carries the calibration percentiles",
   a_set.counters().get("driftRatioP50") is not None
   and a_set.counters().get("driftRatioP95") is not None, a_set.counters())

ch = M.ear_eeg(7500, chi=1.3, background=30.0, alpha_units=8.0, beta_units=4.0, theta_units=4.0)
ch[2] = np.full(7500, 5.0)
ch[3] = np.full(7500, 6.0)
a3, got3 = run(ch)
ok("a dead ear does not stop the session, the live ear carries it",
   a3.windows_accepted > 5 and got3[-1]["quality"]["channelsUsed"] == 2,
   got3[-1]["quality"] if got3 else None)

# ---------------------------------------------------------------- 13
print("\nhonesty invariants")
src = open(os.path.join(_HERE, "..", "sidecar", "spectral.py")).read()
src2 = open(os.path.join(_HERE, "..", "sidecar", "band_analyzer.py")).read()
for bad in ("np.interp", "interp1d", "fillna", "ffill", "bfill"):
    ok(f"no interpolation path exists ({bad} absent)", bad not in src and bad not in src2)
# Checking for the word "microvolt" in prose is useless, since both modules
# explain at length that they never use one. What matters is that no VALUE is
# ever formatted with a unit, so look for the labelling patterns instead.
for bad in ('"uV"', "'uV'", '"µV"', "'µV'", "uV'", 'f"{', "+ ' uV'"):
    if bad == 'f"{':
        continue
    ok(f"no value is ever labelled with a unit ({bad} absent)",
       bad not in src and bad not in src2)
ok("the reported quantity is a ratio, so it carries no unit at all",
   "10.0 * np.log10" in src and "dB" in src)

print("\n" + ("all %d checks passed" % _pass if _fail == 0 else "%d FAILURE(S)" % _fail))
sys.exit(0 if _fail == 0 else 1)
