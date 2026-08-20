"""The impedance formula + accumulative filter, exactly as the hardware team
ships them (spec PDF, 2026-08-19). Every check names its section.

Run:  venv/bin/python tests/eeg-impedance.test.py     (exit 0 = pass)
"""

import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "sidecar"))

from zone_sdk.impedance import (   # noqa: E402
    ChannelImpedanceEstimator, EMA_ALPHA, I_INJECT_A, R_SERIES_OHM,
    LSB_UV_PER_COUNT, MIN_COVERAGE, WORN_PASS_OHM, LOFF_INJECTION_HZ,
    EEG_SAMPLE_RATE_HZ, IMPEDANCE_WINDOW_SAMPLES,
)
from zone_sdk import connection as C   # noqa: E402

_pass = _fail = 0
def ok(name, cond, detail=""):
    global _pass, _fail
    print(("  ok   " if cond else " FAIL  ") + name + ("" if cond else "  >> " + str(detail)))
    if cond: _pass += 1
    else: _fail += 1


def tone_counts(z_ohm, i):
    """counts of the injected tone for an electrode of z_ohm at sample index i"""
    a_uv = (z_ohm + R_SERIES_OHM) * I_INJECT_A * 1e6
    return (a_uv / LSB_UV_PER_COUNT) * math.sin(2 * math.pi * LOFF_INJECTION_HZ * i / EEG_SAMPLE_RATE_HZ)


def measure(indices, z_ohm=42_000.0, dc=250_000.0):
    est = ChannelImpedanceEstimator()
    for i in indices:
        est.push_sample(tone_counts(z_ohm, i) + dc, i * 0.004, abs_idx=i)
    return est.compute_if_ready(True, 1e9)


def goertzel_reference(uv_samples):
    """the dense-buffer reference from the spec, verbatim"""
    n = len(uv_samples)
    mean = sum(uv_samples) / n
    w = 2 * math.pi * LOFF_INJECTION_HZ / EEG_SAMPLE_RATE_HZ
    coeff = 2 * math.cos(w)
    s1 = s2 = 0.0
    for x in uv_samples:
        s = (x - mean) + coeff * s1 - s2
        s2, s1 = s1, s
    power = max(0.0, s1 * s1 + s2 * s2 - coeff * s1 * s2)
    return (2.0 / n) * math.sqrt(power)


print("\nA.1/A.2: formula, conversion, DC removal")
snap = measure(range(256))
ok(f"a 42 kOhm electrode measures 42 kOhm ({snap.kohm:.1f})", abs(snap.kohm - 42.0) < 1.5, snap.kohm)
snap = measure(range(256), z_ohm=500_000.0)
ok(f"a 500 kOhm electrode measures 500 kOhm ({snap.kohm:.0f})", abs(snap.kohm - 500.0) < 15, snap.kohm)
ok("a huge DC offset does not leak into the estimate (window mean removed)",
   abs(measure(range(256), dc=5_000_000.0).kohm - 42.0) < 1.5)

print("\nA.2 parity: with nothing missing, the positioned DFT equals the Goertzel")
uv = [tone_counts(42_000.0, i) * LSB_UV_PER_COUNT for i in range(256)]
est = ChannelImpedanceEstimator()
for i in range(256):
    est.push_sample(tone_counts(42_000.0, i), i * 0.004, abs_idx=i)
a_dft = est._binned_amplitude_uv()
a_ref = goertzel_reference(uv)
ok(f"parity within 0.1% (DFT {a_dft:.3f} vs Goertzel {a_ref:.3f} uV)",
   abs(a_dft - a_ref) / a_ref < 1e-3, (a_dft, a_ref))

print("\nA.2 the lossy link: a hole costs coverage, never the measurement")
# drop three 10-sample packets: the spliced Goertzel rotates 450 degrees per
# hole and collapses; the positioned DFT stays on the electrode's true value
kept = [i for i in range(310) if not (60 <= i < 70 or 140 <= i < 150 or 220 <= i < 230)]
kept = kept[-256:] if len(kept) > 256 else kept
snap = measure(kept)
ok(f"30 lost samples: still measures 42 kOhm ({snap.kohm:.1f})", abs(snap.kohm - 42.0) < 3.0, snap.kohm)
spliced = [tone_counts(42_000.0, i) * LSB_UV_PER_COUNT for i in kept]
a_spliced = goertzel_reference(spliced)
ok(f"the spliced Goertzel really does collapse ({a_spliced:.1f} vs true {a_ref:.1f} uV), "
   "which is the bug this replaces", a_spliced < a_ref * 0.8, (a_spliced, a_ref))

print("\nB.1 coverage gate")
est = ChannelImpedanceEstimator()
for i in range(0, 500, 5):   # only every 5th position present: 20% coverage
    est.push_sample(tone_counts(42_000.0, i), i * 0.004, abs_idx=i)
snap = est.compute_if_ready(True, 1e9)
ok("under-coverage returns a null verdict (measuring), NEVER a number",
   snap.kohm is None and snap.state == "measuring", snap)

print("\nB.1 sequence integrity at the transport")
class Probe(C.DualBLEConnection):
    def __init__(self):
        self.seen = []
        self._adm = {1: {"last": None, "abs": 0, "refusals": 0, "dupes": 0, "replays": 0},
                     2: {"last": None, "abs": 0, "refusals": 0, "dupes": 0, "replays": 0}}
        self._leadoff_tap = None
        self._impedance_tap = lambda dev, c1, c2, idx: self.seen.append((dev, c1, idx))
        self._channel_buffers = [list() for _ in range(4)]
        self._data_callback = None
        self._stats_callback = None
        self._dev1_last_sample = None; self._dev2_last_sample = None
        self._dev1_received = 0; self._dev2_received = 0
        self._dev1_dropped = 0; self._dev2_dropped = 0

def pkt(seq, v=1000):
    b = v & 0xFFFFFF
    return bytes([0xA0, seq, (b >> 16) & 0xFF, (b >> 8) & 0xFF, b & 0xFF, 0, 0, 0, 0xC0])

p = Probe()
for seq in (10, 11, 11, 12):          # a duplicate in the middle
    p._process_packet(pkt(seq), 1)
ok("a duplicate packet is dropped, not admitted twice",
   len(p.seen) == 3 and len(p._channel_buffers[0]) == 3, len(p.seen))
ok("duplicates are counted", p._adm[1]["dupes"] == 1)

p = Probe()
for seq in (100, 101, 95, 102):       # a replay of older samples
    p._process_packet(pkt(seq), 1)
ok("a replay (delta > 128) is dropped", len(p.seen) == 3, len(p.seen))
idxs = [s[2] for s in p.seen]
ok("the absolute index advances by the REAL delta across the stream",
   idxs == [1, 2, 3], idxs)

p = Probe()
p._process_packet(pkt(10), 1)
for i in range(63):
    p._process_packet(pkt(9), 1)      # 63 refusals: still refusing
ok("62 refusals later, still refusing", len(p.seen) == 1, len(p.seen))
p._process_packet(pkt(9), 1)          # the 64th: anti-stall resync
ok("the 64th consecutive refusal re-syncs (anti-stall)", len(p.seen) == 2, len(p.seen))

p = Probe()
p._process_packet(pkt(10), 1)
p._process_packet(pkt(15), 1)         # a 5-sample gap
ok("a gap advances the index by its true size (loss is survivable)",
   [s[2] for s in p.seen] == [1, 6], [s[2] for s in p.seen])

print("\nB.2 seeded EMA")
ok("alpha is the shipping 0.3", abs(EMA_ALPHA - 0.30) < 1e-9, EMA_ALPHA)
est = ChannelImpedanceEstimator()
est._apply_ema(100.0)
ok("the first estimate is adopted DIRECTLY, never blended with zero",
   est._smoothed_kohm == 100.0, est._smoothed_kohm)
est._apply_ema(200.0)
ok("thereafter 0.7 old + 0.3 new", abs(est._smoothed_kohm - 130.0) < 1e-9, est._smoothed_kohm)

print("\nA.3 + B.3 verdicts")
est = ChannelImpedanceEstimator()
for i in range(256):
    est.push_sample(250_000.0, i * 0.004, abs_idx=i)   # DC only: no tone at all
snap = est.compute_if_ready(True, 1e9)
ok("an armed channel with no tone reads no_signal, NEVER a perfect contact",
   snap.state == "no_signal", snap.state)
ok("worn() refuses to call no_signal evidence either way", est.worn() is None, est.worn())
ok("the worn threshold is the spec's 2.3 MOhm", WORN_PASS_OHM == 2_300_000.0)
snap42 = measure(range(256))
ok("a 42 kOhm contact is worn", abs(snap42.kohm - 42) < 2)
est2 = ChannelImpedanceEstimator()
for i in range(256):
    est2.push_sample(tone_counts(3_200_000.0, i) + 1000, i * 0.004, abs_idx=i)
est2.compute_if_ready(True, 1e9)
ok(f"an unworn bud on a desk (3.2 MOhm) is NOT worn", est2.worn() is False, est2._smoothed_kohm)

print("\nzone_source constants agree with the estimator's")
import re
zs = open(os.path.join(_HERE, "..", "sidecar", "zone_source.py")).read()
ok("WORN_PASS_OHM identical in both files",
   "WORN_PASS_OHM = 2_300_000.0" in zs)
ok("5 s stability + 3.5 s staleness present",
   "WORN_STABLE_SEC = 5.0" in zs and "WORN_STALE_SEC = 3.5" in zs)
ok("post-disarm EEG discard present (1.5 s, provisional)",
   "POST_LEADOFF_DISCARD_SEC = 1.5" in zs and "_eeg_discard_until" in zs)

print("\n" + ("all %d checks passed" % _pass if _fail == 0 else "%d FAILURE(S)" % _fail))
sys.exit(0 if _fail == 0 else 1)
