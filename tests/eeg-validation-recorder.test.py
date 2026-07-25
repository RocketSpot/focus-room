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
import stat
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

print("\n-- pre-merge hardening: dir location + perms + non-identifying labels --")
from validation_recorder import ValidationRecorder, _default_dir  # noqa: E402

# item 3: default dir is a LOCAL app-data, NON-synced location — never the repo / cwd / synced folders
dd = _default_dir()
repo = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ok("default dir is under the app-data area (zone-focus-room/validation-captures)",
   "zone-focus-room" in dd and dd.endswith(os.path.join("zone-focus-room", "validation-captures")), dd)
ok("default dir is OUTSIDE the repo and cwd", not os.path.abspath(dd).startswith(repo) and os.path.abspath(dd) != os.getcwd(), dd)
ok("default dir avoids common synced folders",
   all(s not in dd for s in ("Dropbox", "OneDrive", "com~apple~CloudDocs", "/Documents/", "/Desktop/")), dd)

# item 3 + 4: created capture dir is access-restricted (0700); a name-like label is dropped
tmp2 = tempfile.mkdtemp(prefix="focusroom-validation-")
capdir = os.path.join(tmp2, "caps")             # non-existent → recorder creates + chmods it
os.environ["FOCUSROOM_VALIDATION"] = "1"
os.environ["FOCUSROOM_VALIDATION_DIR"] = capdir
try:
    r = ValidationRecorder("Jane Doe participant #42", simulation=False, log=lambda *_: None)  # hostile label
    r.close("test")
    names = os.listdir(capdir)
    ok("item 4: a name-like label is NOT written into filenames",
       all(("jane" not in n.lower() and "doe" not in n.lower() and "42" not in n and "#" not in n) for n in names), names)
    ok("item 4: label reduced to a fixed non-identifying token",
       any(("_session." in n or "_real." in n or "_sim." in n) for n in names), names)
    meta = json.load(open(glob.glob(os.path.join(capdir, "*.meta.json"))[0], encoding="utf-8"))
    ok("item 4: meta flags no participant identifiers", meta.get("containsParticipantIdentifiers") is False, meta.get("containsParticipantIdentifiers"))
    ok("item 3: meta carries a retention/deletion policy",
       "retentionPolicy" in meta and "delete" in meta["retentionPolicy"].lower(), meta.get("retentionPolicy"))
    if os.name == "posix":
        mode = stat.S_IMODE(os.stat(capdir).st_mode)
        ok("item 3: capture dir is access-restricted (0700) on posix", mode == 0o700, oct(mode))
    else:
        ok("item 3: capture dir created (perms best-effort on this OS)", os.path.isdir(capdir))
finally:
    os.environ.pop("FOCUSROOM_VALIDATION", None)
    os.environ.pop("FOCUSROOM_VALIDATION_DIR", None)
    shutil.rmtree(tmp2, ignore_errors=True)

print("\n-- annotation hardening (item 4) + capture-file perms (item 3) --")
tmp3 = tempfile.mkdtemp(prefix="focusroom-validation-")
os.environ["FOCUSROOM_VALIDATION"] = "1"
os.environ["FOCUSROOM_VALIDATION_DIR"] = tmp3
try:
    r = ValidationRecorder("real", simulation=False, log=lambda *_: None)
    r.annotate("blink", t=1)
    r.annotate("Jane Doe <jane@example.com>", t=2, note="participant Jane, age 30")   # hostile kind + note
    r.close("test")
    meta = json.load(open(glob.glob(os.path.join(tmp3, "*.meta.json"))[0], encoding="utf-8"))
    kinds = [a["kind"] for a in meta["annotations"]]
    ok("a known annotation kind is preserved", "blink" in kinds, kinds)
    ok("item 4: a name-like kind is reduced to 'marker'", "marker" in kinds and not any("jane" in k.lower() for k in kinds), kinds)
    ok("item 4: no free-form note is recorded in annotations", all("note" not in a for a in meta["annotations"]))
    blob = (open(glob.glob(os.path.join(tmp3, "*.meta.json"))[0], encoding="utf-8").read()
            + open(glob.glob(os.path.join(tmp3, "*.log.txt"))[0], encoding="utf-8").read())
    ok("item 4: no identifier text leaks into meta/log", ("jane" not in blob.lower()) and ("age 30" not in blob.lower()))
    if os.name == "posix":
        files = (glob.glob(os.path.join(tmp3, "*.raw.ndjson")) + glob.glob(os.path.join(tmp3, "*.meta.json"))
                 + glob.glob(os.path.join(tmp3, "*.log.txt")))
        modes = [stat.S_IMODE(os.stat(f).st_mode) for f in files]
        ok("item 3: all capture files are 0600 on posix", bool(modes) and all(m == 0o600 for m in modes), [oct(m) for m in modes])
finally:
    os.environ.pop("FOCUSROOM_VALIDATION", None)
    os.environ.pop("FOCUSROOM_VALIDATION_DIR", None)
    shutil.rmtree(tmp3, ignore_errors=True)

print("\n" + ("all %d checks passed" % _pass if _fail == 0 else "%d FAILURE(S)" % _fail))
sys.exit(0 if _fail == 0 else 1)
