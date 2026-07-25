"""Phase 2A.2 section 4 — local validation-mode recorder (sidecar/validation_recorder.py).

Proves the recorder is OFF unless explicitly enabled, and when ON records the raw ADC-count
stream (config + raw + quality) to LOCAL files, PRESERVING the original raw ADC counts (not
filtered/decimated display data), captures staff annotations + metadata, labels itself as
engineering validation data, states no-upload / retention-unchanged, and closes cleanly.

Run:  venv/bin/python tests/eeg-validation-recorder.test.py     (exit 0 = pass)
"""

import glob
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sidecar"))

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


print("\n-- validation recorder (opt-in; preserves raw ADC counts) --")

# make sure the env is clean, then import
os.environ.pop("FOCUSROOM_VALIDATION", None)
os.environ.pop("FOCUSROOM_VALIDATION_DIR", None)
from eeg_stream import EegStream  # noqa: E402

# 1) OFF by default — no recorder, and streaming is unaffected
s = EegStream(CaptureTx(), lambda *_: None, simulation=False, expected_rate_hz=FS)
ok("recorder OFF by default (no FOCUSROOM_VALIDATION)", s._recorder is None)

# 2) ON when explicitly enabled — records to a local temp dir
tmp = tempfile.mkdtemp(prefix="focusroom-validation-")
os.environ["FOCUSROOM_VALIDATION"] = "1"
os.environ["FOCUSROOM_VALIDATION_DIR"] = tmp
try:
    s = EegStream(CaptureTx(), lambda *_: None, simulation=False, expected_rate_hz=FS)
    ok("recorder ON when FOCUSROOM_VALIDATION=1", s._recorder is not None and s._recorder.enabled)

    # feed batches with a distinctive per-sample ADC spike on Left-A
    for b in range(20):
        la = [800.0] * 50
        la[10] = 12345.0                         # a spike that must survive verbatim
        s.ingest([la, [700.0] * 50, [600.0] * 50, [500.0] * 50], LABELS, now_monotonic=b * 0.2)
    s.annotate("blink", t=123456789)             # a staff event annotation
    s.close("test")
    ok("recorder closed cleanly (dropped)", s._recorder is None)

    raw_files = glob.glob(os.path.join(tmp, "*.raw.ndjson"))
    meta_files = glob.glob(os.path.join(tmp, "*.meta.json"))
    log_files = glob.glob(os.path.join(tmp, "*.log.txt"))
    ok("raw ndjson + meta.json + log.txt written locally", len(raw_files) == 1 and len(meta_files) == 1 and len(log_files) == 1,
       (raw_files, meta_files, log_files))

    lines = [json.loads(x) for x in open(raw_files[0], encoding="utf-8") if x.strip()]
    types = set(m["type"] for m in lines)
    ok("capture contains config + raw + quality streams", {"eeg/config-v1", "eeg/raw-v1", "eeg/quality-v1"} <= types, types)

    raws = [m for m in lines if m["type"] == "eeg/raw-v1"]
    spike = any(any(abs(v - 12345.0) < 0.05 for v in (m["samples"][0] or [])) for m in raws)
    ok("ORIGINAL raw ADC counts preserved (12345 spike present, not filtered/decimated)", spike)
    ok("raw batches keep every per-sample value (50/batch, per channel)",
       all(m["sampleCount"] == 50 and len(m["samples"][0]) == 50 for m in raws))
    ok("raw units are ADC counts / unverified SDK units (never µV)",
       all(m for m in raws) and next(m for m in lines if m["type"] == "eeg/config-v1")["units"].startswith("adc"))

    meta = json.load(open(meta_files[0], encoding="utf-8"))
    ok("meta clearly labels engineering validation data", meta["capture"] == "engineering-validation" and meta["phase"] == "2A.2")
    ok("meta records the staff annotation (blink)", any(a["kind"] == "blink" for a in meta["annotations"]))
    ok("meta states no-upload + production-retention-unchanged",
       "never uploaded" in meta["note"] and "retention unchanged" in meta["note"], meta["note"])
    ok("meta counts raw batches + samples", meta["counts"]["raw"] >= 1 and meta["counts"]["samples"] >= 50, meta["counts"])
finally:
    os.environ.pop("FOCUSROOM_VALIDATION", None)
    os.environ.pop("FOCUSROOM_VALIDATION_DIR", None)
    shutil.rmtree(tmp, ignore_errors=True)

# 3) confirm the env is off again → recorder OFF (no leakage into other suites)
s = EegStream(CaptureTx(), lambda *_: None, simulation=False, expected_rate_hz=FS)
ok("recorder OFF again after the run (no env leakage)", s._recorder is None)

print("\n" + ("all %d checks passed" % _pass if _fail == 0 else "%d FAILURE(S)" % _fail))
sys.exit(0 if _fail == 0 else 1)
