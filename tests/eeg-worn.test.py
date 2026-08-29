"""Worn vs not worn, tested in BOTH directions.

The fit check must be easy for a person and impossible for a desk. Forgiveness
comes from the enter/stay asymmetry, never from moving the 2.3 MOhm pass
threshold (the doc is explicit that number has no headroom left: an unworn bud
reads 3.0-3.7 MOhm and past roughly 2.5 a desk bud starts to pass).

Direction 1 (worn): reaches good within a few seconds and SURVIVES chewing,
jaw shifts, and glancing around.
Direction 2 (unworn): never reaches good, even briefly, under ambient noise,
dropped packets, duplicated packets, and the missing-lead failure mode.

Run:  venv/bin/python tests/eeg-worn.test.py
"""
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "sidecar"))

from zone_sdk.impedance import (  # noqa: E402
    ChannelImpedanceEstimator, WornGate, EarImpedanceProcessor,
    I_INJECT_A, R_SERIES_OHM, LSB_UV_PER_COUNT, LOFF_INJECTION_HZ,
    EEG_SAMPLE_RATE_HZ, WORN_PASS_OHM, WORN_STAY_OHM, WORN_UNWORN_OHM,
    WORN_ENTER_CONSEC, WORN_GREY_DEMOTE_S, WORN_UNWORN_DEMOTE_S,
)

_pass = 0
_fails = []


def ok(name, cond, detail=""):
    global _pass
    if cond:
        _pass += 1
        print("  ok   " + name)
    else:
        _fails.append(name)
        print(" FAIL  " + name + ("  >> " + str(detail) if detail != "" else ""))


def tone_counts(z_ohm, i):
    """One raw ADC count of the 31.25 Hz lead-off tone across impedance Z."""
    amp_uv = (z_ohm + R_SERIES_OHM) * I_INJECT_A * 1e6
    w = 2.0 * math.pi * LOFF_INJECTION_HZ / EEG_SAMPLE_RATE_HZ
    return (amp_uv / LSB_UV_PER_COUNT) * math.sin(w * i)


# =====================================================================
print("gate: the worn direction (easy for a person)")
# =====================================================================

def run(readings):
    """readings: [(t, kohm_or_None, state)]. Returns the state trace."""
    g = WornGate()
    return [g.update([(k, st)], t) for (t, k, st) in readings]


def ticks(t0, n, kohm, state="high_z", dt=0.5):
    return [(t0 + i * dt, kohm, state) for i in range(n)]


trace = run(ticks(0.0, 6, 1800.0))
ok("a seated wearer reaches good on the 3rd estimate (~2.5 s from arm, not 5 s)",
   trace[:3] == ["checking", "checking", "good"], trace)

# chewing: the estimate bounces into the grey band for 2 ticks, then recovers
chew = ticks(0.0, 4, 1900.0) + ticks(2.0, 3, 2700.0) + ticks(3.5, 6, 2000.0)
trace = run(chew)
ok("a chew that bounces the estimate to 2.7 MOhm for ~1 s does NOT demote",
   "bad" not in trace and trace[-1] == "good", trace)

# jaw shift / glancing around: wobble inside the stay band
wob = ticks(0.0, 4, 1700.0) + ticks(2.0, 20, 2450.0)
trace = run(wob)
ok("a wobble up to 2.45 MOhm (stay band) keeps good indefinitely",
   trace[-1] == "good" and "bad" not in trace, trace[-4:])

# adjusting a bud: one estimate crosses into unworn territory briefly
adj = ticks(0.0, 4, 1600.0) + [(2.0, 3300.0, "open")] + ticks(2.5, 4, 1800.0)
trace = run(adj)
ok("one high estimate while adjusting a bud does not demote (needs 1.5 s sustained)",
   "bad" not in trace and trace[-1] == "good", trace)

trace = run(ticks(0.0, 4, 1600.0) + ticks(2.0, 10, 2700.0))
ok("a SUSTAINED grey-band rise (4 s at 2.7 MOhm) honestly demotes",
   trace[-1] == "bad" and "bad" not in trace[:11], trace)

trace = run(ticks(0.0, 4, 1600.0) + ticks(2.0, 5, 3400.0))
ok("a removed bud (3.4 MOhm sustained) demotes fast (1.5 s)",
   trace[-1] == "bad" and trace[7] == "bad" and "bad" not in trace[:7], trace)

trace = run(ticks(0.0, 4, 1600.0) + [(2.0, 0.0, "no_signal")])
ok("no_signal while good demotes IMMEDIATELY (electrical evidence, not wobble)",
   trace[-1] == "bad", trace)

g = WornGate()
for t in (0.0, 0.5, 1.0):
    g.update([(1600.0, "high_z")], t)
ok("...and once good, silence inside the staleness window holds",
   g.update([(None, "measuring")], 2.0) == "good")
ok("...but silence beyond 3.5 s is staleness, which demotes",
   g.update([(None, "measuring")], 6.0) == "bad")

g = WornGate()
states = [g.update([(1600.0, "high_z"), (3500.0, "open")], t) for t in (0.0, 0.5, 1.0)]
ok("any_required: one good channel carries the side (best trusted channel wins)",
   states[-1] == "good", states)


# =====================================================================
print("\ngate: the unworn direction (impossible for a desk)")
# =====================================================================

desk = ticks(0.0, 240, 3300.0, state="open")   # two minutes on the desk
trace = run(desk)
ok("a desk bud (3.3 MOhm) NEVER reaches good, even briefly, over 2 minutes",
   "good" not in trace, set(trace))

# drifting desk readings across the documented 3.0-3.7 range, incl. the tail
# that dips toward the stay band - it must not matter, entering needs <= 2.3
drift = [(i * 0.5, 3000.0 + 700.0 * math.sin(i / 5.0), "open") for i in range(240)]
trace = run(drift)
ok("desk readings wobbling 2.3-3.7 MOhm never enter (stay band is not an entry)",
   "good" not in trace, set(trace))

near = ticks(0.0, 240, 2400.0, state="open")
ok("even a 2.4 MOhm reading never enters: enter is <= 2.3, tolerance is only for STAYING",
   "good" not in run(near))

broke = ticks(0.0, 2, 1800.0) + [(1.0, 2600.0, "open")] + ticks(1.5, 2, 1800.0)
trace = run(broke)
ok("the enter streak resets on a failing estimate (3 must be CONSECUTIVE)",
   trace[-1] == "checking", trace)

g = WornGate()
a = g.update([(1800.0, "high_z")], 0.0)
b = g.update([(1800.0, "high_z")], 0.1)     # cached snapshot, re-served
c = g.update([(1800.0, "high_z")], 0.2)
ok("a cached snapshot re-served within 0.4 s cannot double-count the streak",
   (a, b, c) == ("checking",) * 3, (a, b, c))

g = WornGate()
g.update([(1800.0, "high_z")], 0.0)
g.update([(1800.0, "high_z")], 0.5)
st = g.update([(1800.0, "high_z")], 600.0)    # a stalled callback, 10 min later
ok("a streak cannot be stitched across a long stall (counts age out at 2.5 s)",
   st == "checking", st)

ns = ticks(0.0, 240, 0.0, state="no_signal")
ok("no_signal (incl. the implausibly-low missing-lead mode) never advances the streak",
   "good" not in run(ns))

ms = [(i * 0.5, None, "measuring") for i in range(240)]
ok("null verdicts (under-coverage on a lossy link) never advance the streak",
   "good" not in run(ms))


# =====================================================================
print("\nfull chain: estimator -> gate, synthetic tone at the exact bin")
# =====================================================================

def chain(z_ohm, n_windows=10, loss=None, dup=False, lead_divisor=1.0, noise=0.0,
          ramp_sec=0.0, tone_dies_at=None):
    """Feed n_windows*256 tone samples through estimator+gate as the real path
    does: push, compute each 500 ms, update the gate on each fresh snapshot.
    loss: keep only positions where (i % 10) >= loss_digits (simulating drops).
    dup: push every sample twice with the same abs_idx (transport would refuse
    these; here we prove even raw duplication cannot conjure a pass)."""
    import random
    rng = random.Random(7)
    est = ChannelImpedanceEstimator()
    g = WornGate()
    trace = []
    now_ms = 0.0
    for i in range(n_windows * 256):
        drop = loss is not None and (i % 10) < loss
        if not drop:
            t = i * 0.004
            x = tone_counts(z_ohm, i) / lead_divisor + 1000
            if ramp_sec and t < ramp_sec:
                # the arm-time transient: tone still ramping to full amplitude
                x = (tone_counts(z_ohm, i) * (t / ramp_sec)) / lead_divisor + 1000
            if tone_dies_at is not None and t >= tone_dies_at:
                x = 1000.0                      # injection stopped; DC only
            if noise:
                x += rng.gauss(0.0, noise)
            est.push_sample(x, i * 0.004, abs_idx=i)
            if dup:
                est.push_sample(x, i * 0.004, abs_idx=i)
        if i % 125 == 0:                       # the 500 ms refresh cadence
            now_ms += 500.0
            snap = est.compute_if_ready(True, now_ms)
            trace.append(g.update([(snap.kohm, snap.state)], now_ms / 1000.0))
    return trace, est


trace, _ = chain(1_500_000.0)
ok("worn 1.5 MOhm: good within ~5 s through the full chain (2 s tone settle + 3 estimates)",
   "good" in trace[:11] and trace[-1] == "good", trace[:11])

trace, _ = chain(1_500_000.0, noise=300.0)
ok("worn survives realistic ADC noise on top of the tone",
   trace[-1] == "good", trace[:11])

trace, _ = chain(3_300_000.0)
ok("desk 3.3 MOhm: never good through the full chain", "good" not in trace, set(trace))

trace, _ = chain(3_300_000.0, noise=800.0)
ok("desk + ambient noise: never good", "good" not in trace, set(trace))

trace, est = chain(3_300_000.0, loss=6)     # 60% loss -> coverage < 50%
ok("desk + 60% packet loss: coverage starves to null verdicts, never good",
   "good" not in trace, set(trace))

trace, _ = chain(3_300_000.0, dup=True)
ok("desk + duplicated samples: never good", "good" not in trace, set(trace))

trace, _ = chain(3_300_000.0, lead_divisor=1000.0)
ok("desk + missing lead command (readings ~1000x low): never good, floor holds",
   "good" not in trace, set(trace))

trace, _ = chain(1_500_000.0, lead_divisor=1000.0)
ok("worn + missing lead command: no fake pass either (clamp/no_signal)",
   "good" not in trace, set(trace))

trace, _ = chain(1_500_000.0, loss=3)       # 30% loss: coverage still >= 50%
ok("worn + moderate loss (30%): the position-aware DFT still reaches good",
   trace[-1] == "good", trace[:11])


# =====================================================================
print("\nreviewed attacks, pinned so none can return")
# =====================================================================
# Each of these reproduced against the pre-review code (adversarial review,
# three lenses, live counterexamples). The invariant they all attacked: a bud
# not on a person must never reach good, even briefly.

trace, _ = chain(3_300_000.0, ramp_sec=1.5)
ok("ATTACK 1, tone-onset transient: desk bud with a 1.5 s tone ramp never good "
   "(the 2 s settle discard eats the ramp)", "good" not in trace, set(trace))

trace, _ = chain(3_300_000.0, ramp_sec=1.9)
ok("...even with the ramp filling the whole settle window", "good" not in trace, set(trace))

trace, est = chain(3_300_000.0, tone_dies_at=6.0)
ok("ATTACK 2, tone loss: desk bud whose tone dies never good (EMA adopts the "
   "collapse instead of decaying through the pass band)", "good" not in trace, set(trace))

def rearm_chain():
    # ATTACK 3, guest handover: guest 1 worn at 100 kOhm, then start_fit
    # re-arms. The fix cycles stop/start so the estimator is REBUILT; this
    # models it faithfully: fresh estimator, fresh gate, desk bud.
    est = ChannelImpedanceEstimator()
    g = WornGate()
    for i in range(1024):
        est.push_sample(tone_counts(100_000.0, i) + 1000, i * 0.004, abs_idx=i)
    est.compute_if_ready(True, 4000.0)
    est = ChannelImpedanceEstimator()        # the cycle rebuilds; EMA gone
    g.reset()
    trace = []
    now_ms = 4000.0
    for i in range(2048):
        est.push_sample(tone_counts(3_300_000.0, i) + 1000, 16.0 + i * 0.004, abs_idx=5000 + i)
        if i % 125 == 0:
            now_ms += 500.0
            snap = est.compute_if_ready(True, now_ms)
            trace.append(g.update([(snap.kohm, snap.state, snap.kohm_raw)], now_ms / 1000.0))
    return trace

ok("ATTACK 3, re-armed fit: guest 2's desk bud never rides guest 1's EMA into good",
   "good" not in rearm_chain())

g = WornGate()
for t in (0.0, 0.5, 1.0):
    g.update([(1600.0, "high_z")], t)
assert g.state == "good"
osc = []
t = 1.5
for _ in range(240):                        # 2 minutes straddling 3.0 MOhm
    for k in (2700.0, 3200.0, 3200.0):
        osc.append(g.update([(k, "open")], t)); t += 0.5
ok("ATTACK 4, kind-flip oscillation: a removed bud straddling 3.0 MOhm demotes "
   "within 4 s, not never", osc[8] == "bad" and "good" not in osc[9:], osc[:10])

est = ChannelImpedanceEstimator(settle_sec=0.0)
g = WornGate()
now_ms = 0.0
for i in range(1024):                       # live link: pushes and computes interleave
    est.push_sample(tone_counts(1_500_000.0, i) + 1000, i * 0.004, abs_idx=i)
    if i % 125 == 0:
        now_ms += 500.0
        snap = est.compute_if_ready(True, now_ms)
        g.update([(snap.kohm, snap.state, snap.kohm_raw)], now_ms / 1000.0)
assert g.state == "good", g.state
frozen = []
for _ in range(20):                          # link dead: NO new samples, 10 s
    now_ms += 500.0
    snap = est.compute_if_ready(True, now_ms)
    frozen.append((snap.state, g.update([(snap.kohm, snap.state, snap.kohm_raw)], now_ms / 1000.0)))
ok("ATTACK 5, frozen buffer: a dead link stops producing evidence (measuring, "
   "not trusted; tick 0 may still drain pre-death samples)",
   all(st == "measuring" for st, _v in frozen[1:]), frozen[:3])
ok("...so staleness finally demotes within 3.5 s", frozen[-1][1] == "bad"
   and any(v == "bad" for _s, v in frozen[:9]), frozen[:9])

def lag_chain():
    # ATTACK 6, EMA lag: worn just long enough for 2 counts, then the desk.
    # Raw desk windows read 3.3 MOhm, so the raw-agreement rule blocks the
    # 3rd count that the smoothed lag (1.77, 2.22 MOhm) used to supply.
    est = ChannelImpedanceEstimator(settle_sec=0.0)
    g = WornGate()
    trace = []
    now_ms = 0.0
    for i in range(2560):
        z = 1_500_000.0 if i * 0.004 < 1.3 else 3_300_000.0
        est.push_sample(tone_counts(z, i) + 1000, i * 0.004, abs_idx=i)
        if i % 125 == 0:
            now_ms += 500.0
            snap = est.compute_if_ready(True, now_ms)
            trace.append(g.update([(snap.kohm, snap.state, snap.kohm_raw)], now_ms / 1000.0))
    return trace

trace = lag_chain()
ok("ATTACK 6, EMA lag: desk-only windows can never finish a worn-built streak "
   "(raw and smoothed must both agree)",
   all(v != "good" for v in trace[4:]), trace)


# =====================================================================
print("\nconstants: the doc's headroom warning is respected")
# =====================================================================
ok("enter threshold IS the spec pass (2.3 MOhm), not a moved number",
   WORN_PASS_OHM == 2_300_000.0)
ok("stay tolerance caps at the doc's 2.5 MOhm desk-onset boundary",
   WORN_STAY_OHM == 2_500_000.0)
ok("unworn signature at 3.0 MOhm, the documented desk floor",
   WORN_UNWORN_OHM == 3_000_000.0)
ok("three consecutive estimates to enter", WORN_ENTER_CONSEC == 3)
ok("grey demotes slower than unworn (forgiveness has the right shape)",
   WORN_GREY_DEMOTE_S > WORN_UNWORN_DEMOTE_S)

print()
print(f"{len(_fails)} FAILURE(S)" if _fails else f"all {_pass} checks passed")
sys.exit(1 if _fails else 0)
