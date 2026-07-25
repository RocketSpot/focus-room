"""Phase 2A — raw transport + honest-quality tests (sidecar/eeg_stream.py).

Pure-stdlib, no hardware. Covers: channel independence + order, continuity/gap +
local index, sample-rate mismatch, flatline/clipping/line-noise prevent "clear",
partial (one-ear) status, and simulation labelling.

Run:  venv/bin/python tests/eeg-raw-transport.test.py     (exit 0 = pass)
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sidecar"))
from eeg_stream import EegStream, ADC_MAX  # noqa: E402

LABELS = ["Left-A", "Left-B", "Right-A", "Right-B"]
FS = 250

_pass = 0
_fail = 0


def ok(name, cond, detail=""):
    global _pass, _fail
    print(("  ok   " if cond else " FAIL  ") + name + ("" if cond else "  — " + str(detail)))
    if cond:
        _pass += 1
    else:
        _fail += 1


class CaptureTx:
    def __init__(self):
        self.msgs = []

    def send_raw(self, m):
        self.msgs.append(m)

    def send(self, type_, **p):
        self.msgs.append({"type": type_, **p})

    def of(self, t):
        return [m for m in self.msgs if m.get("type") == t]

    def last(self, t):
        xs = self.of(t)
        return xs[-1] if xs else None


def sine(freq, n, amp=800.0, phase=0.0, i0=0):
    return [amp * math.sin(2 * math.pi * freq * (i0 + i) / FS + phase) for i in range(n)]


def feed(stream, chans, n_batches, t0=0.0, dt=0.2):
    """Feed n_batches of len-50 batches at a fixed monotonic cadence."""
    t = t0
    for b in range(n_batches):
        cols = [c[b * 50:(b + 1) * 50] if len(c) > b * 50 else sine(10, 50, i0=b * 50) for c in chans]
        stream.ingest(cols, LABELS, now_monotonic=t)
        t += dt
    return t


print("\n-- eeg raw transport + quality --")

# 1) channel independence: an impulse in Left-A must not appear in other channels
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
la = sine(10, 50); la[25] = float(ADC_MAX)          # a big spike on Left-A only
others = sine(10, 50)
s.ingest([la, sine(10, 50, phase=1), sine(10, 50, phase=2), sine(10, 50, phase=3)], LABELS, now_monotonic=0.0)
raw = tx.last("eeg/raw-v1")
ok("channel order preserved (4 labels)", raw["channelLabels"] == LABELS, raw["channelLabels"])
ok("impulse present on Left-A", max(raw["samples"][0]) >= ADC_MAX - 1, max(raw["samples"][0]))
ok("impulse NOT on Left-B/Right-A/Right-B",
   all(max(raw["samples"][c]) < ADC_MAX - 1 for c in (1, 2, 3)),
   [max(raw["samples"][c]) for c in (1, 2, 3)])

# 2) local index monotonic across batches (no device counter exists)
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
feed(s, [sine(10, 500)] * 4, 10)
raws = tx.of("eeg/raw-v1")
firsts = [r["firstSampleIndex"] for r in raws]
ok("local sample index is monotonic", all(firsts[i] < firsts[i + 1] for i in range(len(firsts) - 1)), firsts)
ok("no source timestamp claimed (none exists)", all(r["sourceTimestamp"] is None for r in raws))
ok("monotonic receive timestamp present", all(r["monotonicReceiveTimestamp"] is not None for r in raws))

# 3) a missing batch creates a continuity gap
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
s.ingest([sine(10, 50)] * 4, LABELS, now_monotonic=0.0)
s.ingest([sine(10, 50)] * 4, LABELS, now_monotonic=0.2)
# skip ~0.4 s of samples, then resume — the time jump implies missing samples
s.ingest([sine(10, 50)] * 4, LABELS, now_monotonic=0.8)
gap = tx.of("eeg/raw-v1")[-1]["continuity"]
ok("gap detected after a missing batch", gap["sdkCallbackGapEstimate"] and gap["estimatedMissingSamples"] > 40,
   gap)

# 4) sample-rate mismatch is detected (feed at half the expected rate)
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
t = 0.0
for b in range(40):
    s.ingest([sine(10, 50)] * 4, LABELS, now_monotonic=t)
    t += 0.4                                  # 50 samples / 0.4 s = 125 Hz, not 250
q = tx.last("eeg/quality-v1")
ok("sample-rate mismatch reported", any("throughput_mismatch" in r for r in q["reasons"]), q["reasons"])
ok("observed rate measured (~125 Hz)", 100 < q["connectionQuality"]["ingestThroughputSamplesPerSecond"] < 150,
   q["connectionQuality"]["ingestThroughputSamplesPerSecond"])

# 5) flatline prevents "clear"
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
flat = [10.0] * 50
feed_t = 0.0
for b in range(30):
    s.ingest([flat, flat, flat, flat], LABELS, now_monotonic=feed_t); feed_t += 0.2
q = tx.last("eeg/quality-v1")
ok("flatline never reaches 'clear'", q["overallStatus"] != "clear", q["overallStatus"])
ok("flatline flagged on channels", q["channels"]["Left-A"].get("flatline") is True, q["channels"]["Left-A"])

# 6) clipping prevents "clear"
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
feed_t = 0.0
for b in range(30):
    clip = [float(ADC_MAX)] * 50
    s.ingest([clip, clip, clip, clip], LABELS, now_monotonic=feed_t); feed_t += 0.2
q = tx.last("eeg/quality-v1")
ok("clipping never reaches 'clear'", q["overallStatus"] != "clear", q["overallStatus"])
ok("clipping flagged", q["channels"]["Left-A"].get("clipping") is True, q["channels"]["Left-A"])

# 7) 50/60 Hz line contamination is detected and does not read as clean
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
feed_t = 0.0
for b in range(30):
    line = [500 * math.sin(2 * math.pi * 60 * (b * 50 + i) / FS) for i in range(50)]  # pure 60 Hz
    s.ingest([line, line, line, line], LABELS, now_monotonic=feed_t); feed_t += 0.2
q = tx.last("eeg/quality-v1")
ok("line-noise detected on channel", q["channels"]["Left-A"].get("lineNoise") is True, q["channels"]["Left-A"].get("lineRatio"))
ok("line-contaminated signal is not 'clear'", q["overallStatus"] != "clear", q["overallStatus"])

# 8) one usable ear + one flatlined ear → 'limited' (partial), never 'clear'
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
feed_t = 0.0
for b in range(30):
    good = sine(10, 50, i0=b * 50)
    dead = [11.0] * 50
    s.ingest([good, good, dead, dead], LABELS, now_monotonic=feed_t); feed_t += 0.2
q = tx.last("eeg/quality-v1")
ok("one-ear-usable → 'limited'", q["overallStatus"] == "limited", q["overallStatus"])
ok("left ear selected, right unusable",
   q["selectedConsumerChannels"]["left"] in ("Left-A", "Left-B") and q["selectedConsumerChannels"]["right"] is None,
   q["selectedConsumerChannels"])

# 9) both ears clean and sustained → 'clear'
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=True, expected_rate_hz=FS)
feed_t = 0.0
for b in range(40):
    good = sine(10, 50, i0=b * 50)
    s.ingest([good, sine(10, 50, phase=0.5, i0=b * 50), good, sine(10, 50, phase=1.0, i0=b * 50)],
             LABELS, now_monotonic=feed_t); feed_t += 0.2
q = tx.last("eeg/quality-v1")
ok("clean + sustained → 'clear'", q["overallStatus"] == "clear", q["overallStatus"])

# 10) simulation is always labelled; config never claims µV
cfg = tx.of("eeg/config-v1")[0]
ok("config marks simulation:true", cfg["simulation"] is True)
ok("every raw batch carries simulation flag", all(r["simulation"] is True for r in tx.of("eeg/raw-v1")))
ok("units never claim µV (calibration unverified)",
   "adc" in cfg["units"] and cfg["calibrationStatus"] == "unverified", cfg["units"])
ok("robust amplitude reported in COUNTS, not µV", "robustAmplitudeCounts" in q["channels"]["Left-A"])

print("\n-- 2A.1: real-mode clear gate, hysteresis, flatline vs gap --")

# 11) REAL mode is capped below 'clear' until thresholds are validated
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)  # real
feed_t = 0.0
for b in range(40):
    good = sine(10, 50, i0=b * 50)
    s.ingest([good, sine(10, 50, phase=.5, i0=b * 50), good, sine(10, 50, phase=1, i0=b * 50)],
             LABELS, now_monotonic=feed_t, sdk_rate=FS); feed_t += 0.2
q = tx.last("eeg/quality-v1"); cfg = tx.of("eeg/config-v1")[0]
ok("real mode: clearStateEnabled is false", cfg["clearStateEnabled"] is False and q["clearStateEnabled"] is False)
ok("real mode never shows 'clear' (shows 'received')", q["overallStatus"] == "received", q["overallStatus"])
ok("reason cites threshold validation", any("threshold" in r for r in q["reasons"]), q["reasons"])
ok("qualityThresholdStatus provisional", cfg["qualityThresholdStatus"] == "provisional")

# 12) rate/continuity terminology present + honest (no device measurement)
ok("config: device sample-rate measurement unavailable",
   cfg["deviceSampleRateMeasurementAvailable"] is False and cfg["deviceMeasuredSampleRateHz"] is None)
ok("config: sdkReportedSampleRateHz carried, confidence unverified",
   cfg["sdkReportedSampleRateHz"] == FS and cfg["sampleRateConfidence"] == "unverified")
ok("quality: throughput + cadence + mean-batch reported",
   all(k in q["connectionQuality"] for k in ("ingestThroughputSamplesPerSecond", "callbackCadenceHz", "meanSamplesPerCallback")))
ok("continuity: device unavailable, method+confidence stated",
   q["packetContinuity"]["deviceContinuityAvailable"] is False and q["packetContinuity"]["continuityConfidence"] == "low")

# 13) hysteresis: a single noisy window must NOT flap the selected channel
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=True, expected_rate_hz=FS)
feed_t = 0.0
sel_seq = []
for b in range(60):
    la = sine(10, 50, i0=b * 50)
    lb = sine(10, 50, phase=0.5, i0=b * 50)
    if b % 7 == 3:                 # Left-A gets ONE clipped window intermittently
        la = [float(ADC_MAX)] * 50
    ra = sine(10, 50, i0=b * 50)
    s.ingest([la, lb, ra, sine(10, 50, phase=1, i0=b * 50)], LABELS, now_monotonic=feed_t); feed_t += 0.2
    qq = tx.last("eeg/quality-v1")
    if qq:
        sel_seq.append(qq["selectedConsumerChannels"]["left"])
# post-settle stability: once selection settles (2nd half), it must NOT oscillate A<->B
settled = [x for x in sel_seq[30:] if x is not None]
ok("no channel flapping once settled (single stable channel in 2nd half)", len(set(settled)) == 1, set(settled))
# and no back-and-forth A->B->A anywhere
real = [x for x in sel_seq if x is not None]
ab_oscillations = sum(1 for i in range(2, len(real)) if real[i] == real[i - 2] and real[i] != real[i - 1])
ok("no A<->B oscillation across the run", ab_oscillations == 0, ab_oscillations)
ok("selection records a reason", isinstance(qq["selectedConsumerChannels"]["reason"]["left"], str))
ok("selection records confidence", qq["selectedConsumerChannels"]["confidence"]["left"] in ("high", "medium", "low", "none"))

# 14) sustained failure DOES switch, with switched=true + a stated reason + switchAtIndex
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=True, expected_rate_hz=FS)
feed_t = 0.0
saw_switch = False; switch_reason = None
for b in range(60):
    la = sine(10, 50, i0=b * 50) if b < 20 else [10.0] * 50   # Left-A dies permanently at b=20
    lb = sine(10, 50, phase=0.5, i0=b * 50)                    # Left-B stays clean
    s.ingest([la, lb, sine(10, 50, i0=b * 50), sine(10, 50, phase=1, i0=b * 50)], LABELS, now_monotonic=feed_t); feed_t += 0.2
    qq = tx.last("eeg/quality-v1")
    if qq and qq["selectedConsumerChannels"]["switched"]["left"] and b > 20:
        saw_switch = True; switch_reason = qq["selectedConsumerChannels"]["reason"]["left"]
ok("sustained failure switches Left-A → Left-B", qq["selectedConsumerChannels"]["left"] == "Left-B", qq["selectedConsumerChannels"]["left"])
ok("the switch was flagged with a reason", saw_switch and "unusable" in (switch_reason or ""), switch_reason)
ok("switchAtIndex recorded for the ear", qq["selectedConsumerChannels"]["switchAtIndex"]["left"] is not None)

# 15) FLATLINE (present samples, no variation) is DISTINCT from a GAP (no samples).
#     flatline: samples received, drawn-able, marked unusable. gap: estimatedMissingSamples>0.
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
for b in range(20):
    s.ingest([[10.0] * 50, [10.0] * 50, [10.0] * 50, [10.0] * 50], LABELS, now_monotonic=b * 0.2)
raw_flat = tx.of("eeg/raw-v1")[-1]; q_flat = tx.last("eeg/quality-v1")
ok("flatline: samples ARE present (not a gap)", raw_flat["sampleCount"] == 50 and raw_flat["continuity"]["estimatedMissingSamples"] == 0)
ok("flatline: channel present but flagged flatline+unusable",
   q_flat["channels"]["Left-A"]["present"] is True and q_flat["channels"]["Left-A"]["flatline"] is True and q_flat["channels"]["Left-A"]["eligible"] is False)

tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
s.ingest([sine(10, 50)] * 4, LABELS, now_monotonic=0.0)
s.ingest([sine(10, 50)] * 4, LABELS, now_monotonic=1.0)   # a 0.8 s hole → gap
raw_gap = tx.of("eeg/raw-v1")[-1]
ok("gap: samples MISSING (estimatedMissingSamples>0), distinct from flatline",
   raw_gap["continuity"]["sdkCallbackGapEstimate"] is True and raw_gap["continuity"]["estimatedMissingSamples"] > 100,
   raw_gap["continuity"])
ok("gap: continuity confidence is low + labelled inference",
   raw_gap["continuity"]["continuityConfidence"] == "low" and raw_gap["continuity"]["continuityMethod"] == "callback_timing_inference")

print("\n-- 2A.2 correction 1: eligibility state machine (transport != analysis) --")


def last_elig(tx):
    q = tx.last("eeg/quality-v1")
    return q["eligibility"] if q else None


# 16) packet arrival alone (flatline both ears) → transportReady, but NOT analysisEligible
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
for b in range(20):
    s.ingest([[10.0] * 50] * 4, LABELS, now_monotonic=b * 0.2)
e = last_elig(tx)
ok("eligibility object present on quality message", e is not None)
ok("packets arriving → transportReady true", e["transportReady"] is True, e)
ok("flatline packets → analysisEligible false (receipt is not analysis)", e["analysisEligible"] is False, e)
ok("flatline packets → displayEligible true (present, drawable)", e["displayEligible"] is True, e)
ok("neither ear usable → status stays off provisional-pass", e["eligibilityStatus"] in ("failed", "checking"), e["eligibilityStatus"])

# 17) one usable ear (right ear absent) cannot produce analysisEligible
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
for b in range(30):
    s.ingest([sine(10, 50, i0=b * 50), sine(10, 50, phase=.5, i0=b * 50)],
             ["Left-A", "Left-B"], now_monotonic=b * 0.2)   # only the left ear present
e = last_elig(tx)
ok("one ear present → analysisEligible false", e["analysisEligible"] is False, e)
ok("one ear present → eligibilityStatus 'limited'", e["eligibilityStatus"] == "limited", e)
ok("left usable, right not usable", e["ears"]["left"]["usable"] is True and e["ears"]["right"]["usable"] is False, e["ears"])

# 18) one usable CHANNEL on each ear (Left-A + Right-A) → PROVISIONAL analysis eligibility
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
for b in range(40):
    s.ingest([sine(10, 50, i0=b * 50), sine(11, 50, i0=b * 50)],
             ["Left-A", "Right-A"], now_monotonic=b * 0.2)   # exactly one channel per ear
e = last_elig(tx)
ok("one clean channel per ear → analysisEligible true", e["analysisEligible"] is True, e)
ok("one clean channel per ear → status 'provisional-pass'", e["eligibilityStatus"] == "provisional-pass", e)
ok("eligibility is labelled provisional (not validated)", e["qualityThresholdStatus"] == "provisional", e)

# 19) flatline on an ear's channels prevents analysisEligible
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
for b in range(40):
    dead = [10.0] * 50
    s.ingest([sine(10, 50, i0=b * 50), sine(10, 50, phase=.5, i0=b * 50), dead, dead],
             LABELS, now_monotonic=b * 0.2)               # right ear flatlined
e = last_elig(tx)
ok("flatlined ear → analysisEligible false", e["analysisEligible"] is False, e)
ok("flatlined ear → that ear not usable", e["ears"]["right"]["usable"] is False, e["ears"])

# 20) clipping on an ear's channels prevents analysisEligible
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
for b in range(40):
    clip = [float(ADC_MAX)] * 50
    s.ingest([sine(10, 50, i0=b * 50), sine(10, 50, phase=.5, i0=b * 50), clip, clip],
             LABELS, now_monotonic=b * 0.2)               # right ear clipping
e = last_elig(tx)
ok("clipping ear → analysisEligible false", e["analysisEligible"] is False, e)

# 21) revealEligible is SEPARATE from analysisEligible — a HIGHER bar (sustained coverage)
tx = CaptureTx()
s = EegStream(tx, lambda *_: None, simulation=False, expected_rate_hz=FS)
for b in range(6):                          # a few clean batches: analysis passes, reveal not yet
    s.ingest([sine(10, 50, i0=b * 50), sine(10, 50, phase=.5, i0=b * 50),
              sine(11, 50, i0=b * 50), sine(11, 50, phase=.5, i0=b * 50)], LABELS, now_monotonic=b * 0.2)
e = last_elig(tx)
ok("early clean session: analysisEligible true", e["analysisEligible"] is True, e)
ok("early clean session: revealEligible STILL false (separate, higher bar)", e["revealEligible"] is False, e)
ok("reveal + analysis are distinct fields", ("revealEligible" in e) and ("analysisEligible" in e))
for b in range(6, 44):                       # sustain → reveal becomes eligible
    s.ingest([sine(10, 50, i0=b * 50), sine(10, 50, phase=.5, i0=b * 50),
              sine(11, 50, i0=b * 50), sine(11, 50, phase=.5, i0=b * 50)], LABELS, now_monotonic=b * 0.2)
e2 = last_elig(tx)
ok("sustained clean session: revealEligible becomes true", e2["revealEligible"] is True, e2)

# 22) staffOverride defaults false at the signal layer (the app overlays a real override)
ok("signal-layer staffOverride defaults false", e2["staffOverride"] is False, e2)

print("\n" + ("all %d checks passed" % _pass if _fail == 0 else "%d FAILURE(S)" % _fail))
sys.exit(0 if _fail == 0 else 1)
