"""Motion/drift rejection — proves the delta-dominance bug is actually fixed.

A real recorded session (data/sessions/session-1785017923930.json) measured delta at
77% mean / 83% median / 99.8% peak on an AWAKE, READING guest. That is motion and
electrode-contact drift, not brain delta: the stock config band-passed from 0.5 Hz and
defined delta as 0.5-4 Hz, so drift landed inside delta and — because bands are reported
as RELATIVE shares — crushed alpha/beta/theta into the noise floor.

Raw ADC from that session is deliberately not retained (it is ephemeral by design), so
this test reconstructs the failure mechanism through the REAL SDK pipeline: synthesised
EEG with a known alpha rhythm, plus a realistic large low-frequency movement drift. It
asserts the OLD config reproduces the delta blow-out and the NEW config recovers the
true band structure — i.e. a guest can move without wrecking their reading.

Run:  venv/bin/python tests/eeg-drift-rejection.test.py     (exit 0 = pass)
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sidecar"))

_pass = 0
_fail = 0


def ok(name, cond, detail=""):
    global _pass, _fail
    print(("  ok   " if cond else " FAIL  ") + name + ("" if cond else "  — " + str(detail)))
    if cond:
        _pass += 1
    else:
        _fail += 1


FS = 250
DUR = 8.0
N = int(FS * DUR)
t = np.arange(N) / FS


def synth_channel(seed, drift_uv):
    """Awake EEG: broadband background + a clear 10 Hz alpha + a 20 Hz beta, then a
    big slow movement drift on top (the thing a guest does when they shift or chew)."""
    rng = np.random.default_rng(seed)
    eeg = 6.0 * rng.standard_normal(N)                       # broadband background
    eeg += 12.0 * np.sin(2 * np.pi * 10.0 * t + rng.random())  # alpha, the dominant rhythm
    eeg += 5.0 * np.sin(2 * np.pi * 20.0 * t + rng.random())   # beta
    # movement/contact drift: slow, large, exactly where the old delta band sat
    drift = (drift_uv * np.sin(2 * np.pi * 0.35 * t)
             + 0.7 * drift_uv * np.sin(2 * np.pi * 0.9 * t + 1.1)
             + 0.4 * drift_uv * np.sin(2 * np.pi * 1.6 * t + 2.3))
    return eeg + drift


BANDS5 = ["delta", "theta", "alpha", "beta", "gamma"]


def shares_with(hp_hz, delta_band, drift_uv, order=6):
    """Run the REAL SDK spectral path at a given config and return the five band shares,
    normalised over those five exactly as the reveal/reads normalise them."""
    import zone_sdk.processors as P
    # configure BEFORE constructing the processors (they read CONFIG in __init__)
    P.CONFIG["filter"]["bandpass_low_hz"] = hp_hz
    P.CONFIG["filter"]["bandpass_order"] = order
    P.CONFIG["bands"]["delta"] = list(delta_band)
    filt = P.EEGFilter() if hasattr(P, "EEGFilter") else P.FilterBank()
    spec = P.SpectralAnalyzer()
    data = np.stack([synth_channel(s, drift_uv) for s in range(4)], axis=1)
    rel = spec.analyze(filt.filter(data))["relative"]
    tot = sum(max(0.0, rel.get(k, 0.0)) for k in BANDS5) or 1e-9
    return {k: max(0.0, rel.get(k, 0.0)) / tot for k in BANDS5}


print("\n-- motion-drift rejection (real SDK spectral path) --")

# sanity: the SDK exposes what we need
try:
    import zone_sdk.processors as P  # noqa: F401
    have = True
except Exception as e:
    have = False
    print("  SKIP — zone_sdk not importable:", e)

if have:
    import zone_sdk.processors as P
    FILT = "EEGFilter" if hasattr(P, "EEGFilter") else "FilterBank"
    ok("SDK spectral path is reachable", hasattr(P, "SpectralAnalyzer") and hasattr(P, FILT))

    DRIFT = 220.0     # a firm but ordinary movement: ~18x the alpha amplitude

    # ---- OLD config: high-pass 0.5 Hz, delta 0.5-4 Hz -> the reported failure ----
    old = shares_with(0.5, (0.5, 4.0), DRIFT, order=4)
    old_delta = old.get("delta", 0)
    print(f"     OLD (hp 0.5, delta 0.5-4): delta={old_delta:.1%} alpha={old.get('alpha',0):.1%} beta={old.get('beta',0):.1%}")
    ok("OLD config reproduces the delta blow-out seen in the real session (>60%)",
       old_delta > 0.60, f"delta={old_delta:.1%}")
    ok("OLD config buries the real alpha rhythm (<15%)",
       old.get("alpha", 0) < 0.15, f"alpha={old.get('alpha',0):.1%}")

    # ---- NEW config: high-pass 2 Hz, delta 2-4 Hz -> drift rejected ----
    new = shares_with(2.0, (2.0, 4.0), DRIFT)
    new_delta = new.get("delta", 0)
    print(f"     NEW (hp 2.0, delta 2-4  ): delta={new_delta:.1%} alpha={new.get('alpha',0):.1%} beta={new.get('beta',0):.1%}")
    ok("NEW config keeps delta plausible for an awake guest (<25%)",
       new_delta < 0.25, f"delta={new_delta:.1%}")
    ok("NEW config recovers the real alpha rhythm as dominant",
       new.get("alpha", 0) > max(new_delta, new.get("theta", 0), new.get("gamma", 0)),
       f"alpha={new.get('alpha',0):.1%} vs delta={new_delta:.1%}")
    ok("NEW config cuts delta by a large factor vs OLD",
       new_delta < old_delta / 2.5, f"old={old_delta:.1%} new={new_delta:.1%}")
    ok("beta survives for the notification ratio to be able to move",
       new.get("beta", 0) > 0.05, f"beta={new.get('beta',0):.1%}")

    # ---- THE POINT: a guest may MOVE without being punished for it ----
    # Nobody should have to hold their head, jaw and body still to be measured. Across
    # everything from sitting still to a violent shift, the real rhythm must stay the
    # dominant one and delta must stay plausible.
    calm = shares_with(2.0, (2.0, 4.0), 20.0)      # sitting still
    normal = shares_with(2.0, (2.0, 4.0), 220.0)   # ordinary shifting / looking around
    lots = shares_with(2.0, (2.0, 4.0), 400.0)     # restless: chewing, turning
    violent = shares_with(2.0, (2.0, 4.0), 800.0)  # a big deliberate movement
    for nm, r in (("still", calm), ("normal", normal), ("restless", lots), ("violent", violent)):
        print(f"     {nm:9s} delta={r['delta']:5.1%} alpha={r['alpha']:5.1%} beta={r['beta']:5.1%}")
    ok("ordinary movement barely shifts the rhythm balance (alpha within 8 points of still)",
       abs(normal["alpha"] - calm["alpha"]) < 0.08, f"still={calm['alpha']:.1%} normal={normal['alpha']:.1%}")
    ok("even a RESTLESS guest keeps the true rhythm dominant",
       lots["alpha"] > max(lots["delta"], lots["theta"], lots["gamma"]),
       f"alpha={lots['alpha']:.1%} delta={lots['delta']:.1%}")
    ok("even a VIOLENT movement keeps the true rhythm dominant",
       violent["alpha"] > violent["delta"], f"alpha={violent['alpha']:.1%} delta={violent['delta']:.1%}")
    ok("delta stays plausible for an awake guest at every movement level (<35%)",
       max(calm["delta"], normal["delta"], lots["delta"], violent["delta"]) < 0.35,
       f"max delta={max(calm['delta'], normal['delta'], lots['delta'], violent['delta']):.1%}")
    ok("beta always survives, so the notification always has room to move",
       min(calm["beta"], normal["beta"], lots["beta"], violent["beta"]) > 0.03,
       f"min beta={min(calm['beta'], normal['beta'], lots['beta'], violent['beta']):.1%}")

# ---- the runtime tuning + omission policy are wired ----
os.environ.pop("FOCUSROOM_ANALYSIS_HP_HZ", None)
import zone_source  # noqa: E402

ok("analysis high-pass sits above the drift floor", zone_source.ANALYSIS_HP_HZ >= 1.5,
   zone_source.ANALYSIS_HP_HZ)
ok("delta band starts at the high-pass (never below it)",
   zone_source.DELTA_BAND[0] >= zone_source.ANALYSIS_HP_HZ, zone_source.DELTA_BAND)
if have:
    import zone_sdk.processors as P
    P.CONFIG["filter"].pop("_focusroom_tuned", None)
    zone_source._tune_for_mobile_ear_eeg(None)
    ok("tuning raises the SDK high-pass", P.CONFIG["filter"]["bandpass_low_hz"] == zone_source.ANALYSIS_HP_HZ,
       P.CONFIG["filter"]["bandpass_low_hz"])
    ok("tuning narrows the delta band", tuple(P.CONFIG["bands"]["delta"]) == zone_source.DELTA_BAND,
       P.CONFIG["bands"]["delta"])
    ok("artifact INTERPOLATION is disabled (never bridge a movement)",
       P.CONFIG["artifact"]["max_interpolation_pct"] == 0.0,
       P.CONFIG["artifact"]["max_interpolation_pct"])
    ok("tuning is idempotent", (zone_source._tune_for_mobile_ear_eeg(None) or True)
       and P.CONFIG["filter"]["bandpass_low_hz"] == zone_source.ANALYSIS_HP_HZ)

print("\n" + ("all %d checks passed" % _pass if _fail == 0 else "%d FAILURE(S)" % _fail))
sys.exit(0 if _fail == 0 else 1)
