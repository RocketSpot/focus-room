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
    ChannelImpedanceEstimator, EarImpedanceProcessor, EMA_ALPHA,
    MIN_PLAUSIBLE_OHM, I_INJECT_A, R_SERIES_OHM,
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
    est = ChannelImpedanceEstimator(settle_sec=0.0)
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
est = ChannelImpedanceEstimator(settle_sec=0.0)
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
est = ChannelImpedanceEstimator(settle_sec=0.0)
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
est = ChannelImpedanceEstimator(settle_sec=0.0)
est._apply_ema(100.0)
ok("the first estimate is adopted DIRECTLY, never blended with zero",
   est._smoothed_kohm == 100.0, est._smoothed_kohm)
est._apply_ema(200.0)
ok("thereafter 0.7 old + 0.3 new", abs(est._smoothed_kohm - 130.0) < 1e-9, est._smoothed_kohm)

print("\nA.3 + B.3 verdicts")
est = ChannelImpedanceEstimator(settle_sec=0.0)
for i in range(256):
    est.push_sample(250_000.0, i * 0.004, abs_idx=i)   # DC only: no tone at all
snap = est.compute_if_ready(True, 1e9)
ok("an armed channel with no tone reads no_signal, NEVER a perfect contact",
   snap.state == "no_signal", snap.state)
ok("worn() refuses to call no_signal evidence either way", est.worn() is None, est.worn())
ok("the worn threshold is the spec's 2.3 MOhm", WORN_PASS_OHM == 2_300_000.0)
snap42 = measure(range(256))
ok("a 42 kOhm contact is worn", abs(snap42.kohm - 42) < 2)
est2 = ChannelImpedanceEstimator(settle_sec=0.0)
for i in range(256):
    est2.push_sample(tone_counts(3_200_000.0, i) + 1000, i * 0.004, abs_idx=i)
est2.compute_if_ready(True, 1e9)
ok(f"an unworn bud on a desk (3.2 MOhm) is NOT worn", est2.worn() is False, est2._smoothed_kohm)

print("\nzone_source constants agree with the estimator's")
import re
zs = open(os.path.join(_HERE, "..", "sidecar", "zone_source.py")).read()
ok("the 2.3 MOhm pass default is untouched (the doc says it has no headroom)",
   '"FOCUSROOM_WORN_PASS_OHM", "2300000"' in zs)
ok("the verdict is the asymmetric WornGate, reset on every arm",
   "WornGate(" in zs and "g.reset()" in zs)
ok("the verdict never gates the guest: start_session does not consult it",
   "_worn_gate" not in zs.split("async def start_session")[1].split("def _flush_stale_buffers")[0])
ok("post-disarm EEG discard present (1.5 s, provisional)",
   "POST_LEADOFF_DISCARD_SEC = 1.5" in zs and "_eeg_discard_until" in zs)

print("\nA.0 the REAL constructor (the Probe subclass below bypasses __init__)")
# The review's reset_dev1_stats fix was applied with an unbounded replace and
# clobbered the identical initializer block inside __init__ - the sidecar then
# crash-looped on real hardware while all 34 checks here stayed green, because
# Probe defines its own __init__. The real constructor gets its own checks.
real = C.DualBLEConnection()
ok("DualBLEConnection() constructs with both admission epochs",
   real._adm[1]["abs"] == 0 and real._adm[2]["abs"] == 0)
real._adm[2]["abs"] = 777
real.reset_dev1_stats()
ok("reset_dev1_stats resets device 1 and leaves device 2's epoch alone",
   real._adm[1]["abs"] == 0 and real._adm[2]["abs"] == 777,
   (real._adm[1]["abs"], real._adm[2]["abs"]))

print("\nA.1 wrap boundary + channel lockstep")
p = Probe()
p._process_packet(pkt(10), 1)
p._process_packet(pkt((10 + 128) % 256, 1000), 1)   # delta exactly 128: forward gap
ok("delta of exactly 128 is a forward gap, admitted",
   [s[2] for s in p.seen] == [1, 129], [s[2] for s in p.seen])
p = Probe()
p._process_packet(pkt(10), 1)
p._process_packet(pkt((10 + 129) % 256, 1000), 1)   # delta 129 reads as -127: replay
ok("delta of 129 reads as a replay, refused", len(p.seen) == 1, len(p.seen))
proc = EarImpedanceProcessor(side="L", settle_sec=0.0)
proc.ingest(1000.0, 2000.0, 0.0, abs_idx=7)
ok("both channels of a packet advance together on ONE stream position",
   proc.ch1._buf[-1][1] == 7 and proc.ch2._buf[-1][1] == 7)

print("\nA.4 plausibility floor (the missing-lead failure mode)")
# lead command missing => amplitude ~1000x low. A worn bud maps below zero
# (no_signal by the clamp); a DESK bud maps to ~800-1500 Ohm, which without
# the floor would read as a superb contact and PASS. It must never.
est3 = ChannelImpedanceEstimator(settle_sec=0.0)
for i in range(256):
    est3.push_sample(tone_counts(3_300_000.0, i) / 1000.0 + 1000, i * 0.004, abs_idx=i)
snap3 = est3.compute_if_ready(True, 1e9)
ok("a desk bud with the lead command missing reads no_signal, never a pass",
   snap3.state == "no_signal", (snap3.state, est3._smoothed_kohm))
ok("...and worn() refuses to treat it as evidence", est3.worn() is None)
ok("...with the hint naming the missing tone",
   snap3.hint is not None and "lead-off tone missing" in snap3.hint, snap3.hint)
est4 = ChannelImpedanceEstimator(settle_sec=0.0)
for i in range(256):
    est4.push_sample(tone_counts(1_500_000.0, i) / 1000.0 + 1000, i * 0.004, abs_idx=i)
snap4 = est4.compute_if_ready(True, 1e9)
ok("a worn bud with the lead command missing is caught too",
   snap4.state == "no_signal" and est4.worn() is None, (snap4.state, est4._smoothed_kohm))
ok("a genuine 42 kOhm contact still sits ABOVE the floor (floor is 10 kOhm)",
   MIN_PLAUSIBLE_OHM == 10_000.0 and snap42.state != "no_signal",
   (MIN_PLAUSIBLE_OHM, snap42.state))

print("\nfit-path epoch hygiene (source-pinned)")
ok("start_fit cycles a still-armed check so estimators really rebuild",
   "cycling for a fresh estimator epoch" in zs
   and "stop_impedance" in zs.split("async def start_fit")[1].split("async def _battery_gate")[0])
ok("a reconnect during an armed fit re-arms the lead tone (fresh epoch)",
   "re-arming the lead tone" in zs)
zc = open(os.path.join(_HERE, "..", "sidecar", "zone_sdk", "connection.py")).read()
ok("reset_dev1_stats leaves device 2's admission epoch alone",
   'self._adm[1] = {"last": None' in zc.split("def reset_dev1_stats")[1].split("def reset_dev2_stats")[0])
zn = open(os.path.join(_HERE, "..", "sidecar", "zone_sdk", "zone.py")).read()
ok("single-bud fit: alignment only waits for CONNECTED sides",
   "_imp_need_left" in zn and "_imp_need_right" in zn)
est5 = ChannelImpedanceEstimator(settle_sec=0.0)
for i in range(256):
    est5.push_sample(tone_counts(42_000.0, i) + 1000, i * 0.004, abs_idx=i)
s5 = est5.compute_if_ready(True, 1e9)
ok("snapshots carry the raw window estimate alongside the smoothed",
   s5.kohm_raw is not None and abs(s5.kohm_raw - 42.0) < 2.0, s5.kohm_raw)
est6 = ChannelImpedanceEstimator(settle_sec=0.0)
for i in range(256):
    est6.push_sample(1000.0, i * 0.004, abs_idx=i)      # no tone
s6 = est6.compute_if_ready(True, 1e9)
ok("phase never reads good on a no_signal channel", s6.phase == "bad", (s6.state, s6.phase))
est7 = ChannelImpedanceEstimator()                       # REAL settle
for i in range(1024):
    est7.push_sample(tone_counts(42_000.0, i) + 1000, i * 0.004, abs_idx=i)
ok("the settle discard really eats the epoch's first 2 s (production default)",
   len(est7._buf) > 0 and min(t for t in est7._tbuf) >= 2.0,
   (len(est7._buf), min(est7._tbuf) if est7._tbuf else None))

print("\n" + ("all %d checks passed" % _pass if _fail == 0 else "%d FAILURE(S)" % _fail))
sys.exit(0 if _fail == 0 else 1)
