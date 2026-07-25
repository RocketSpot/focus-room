"""Local validation-mode recorder (Phase 2A.2, section 4) — OFF unless FOCUSROOM_VALIDATION=1.

An EXPLICIT, opt-in engineering recorder for the real-hardware validation run. It taps the
three raw messages (``eeg/config-v1``, ``eeg/raw-v1``, ``eeg/quality-v1``) plus timing/
continuity metadata and staff event annotations, and writes them to LOCAL files only:

  * ``<ts>_<label>.raw.ndjson`` — the raw stream, one JSON object per line. Preserves the
    ORIGINAL raw ADC counts (never filtered or decimated display data).
  * ``<ts>_<label>.meta.json``  — capture metadata + counters + staff annotations.
  * ``<ts>_<label>.log.txt``    — a human-readable validation log.

DISCIPLINE (matches the user's section-4 requirements):
  * Records ONLY because validation mode was explicitly enabled (env FOCUSROOM_VALIDATION=1).
  * NEVER uploads raw EEG to analytics or any cloud service — local files only.
  * Does NOT change normal production retention (this is a separate, opt-in path).
  * Clearly labels the capture as engineering validation data.
  * Closes/flushes the files cleanly on stop, disconnect, or application exit.

Pure stdlib; time.* is fine here (this is the app sidecar, not a restricted sandbox).
"""

import json
import os
import time


def enabled():
    return os.environ.get("FOCUSROOM_VALIDATION") == "1"


class ValidationRecorder:
    def __init__(self, session_label, simulation, log=None):
        self.log = log or (lambda *_: None)
        self.simulation = bool(simulation)
        self.enabled = False
        self.counts = {"config": 0, "raw": 0, "quality": 0, "samples": 0, "gaps": 0}
        self.annotations = []
        self._raw_f = self._log_f = None
        base = os.environ.get("FOCUSROOM_VALIDATION_DIR") or os.path.join(os.getcwd(), "validation-captures")
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        label = "".join(c if (c.isalnum() or c in "-_") else "_" for c in str(session_label or "session"))[:40]
        try:
            os.makedirs(base, exist_ok=True)
            self.stem = os.path.join(base, f"{stamp}_{label}")
            self.raw_path = self.stem + ".raw.ndjson"
            self.meta_path = self.stem + ".meta.json"
            self.log_path = self.stem + ".log.txt"
            self._raw_f = open(self.raw_path, "w", encoding="utf-8")
            self._log_f = open(self.log_path, "w", encoding="utf-8")
            self.started_wall = time.time()
            self.started_mono = time.monotonic()
            self.enabled = True
            self._logline("VALIDATION CAPTURE OPEN — ENGINEERING DATA (NOT a guest record). "
                          f"simulation={self.simulation}. Preserves ORIGINAL raw ADC counts. "
                          "Local files only; no upload; production retention unchanged.")
        except Exception as e:  # never let a recorder failure break streaming
            self.log(f"validation recorder init failed: {e}")
            self.enabled = False

    def record(self, msg):
        """Append one config/raw/quality message verbatim (raw ADC counts preserved)."""
        if not self.enabled or not self._raw_f:
            return
        t = msg.get("type", "")
        try:
            self._raw_f.write(json.dumps(msg, separators=(",", ":")) + "\n")
            self._raw_f.flush()
        except Exception as e:
            self.log(f"validation record error: {e}")
            return
        if t == "eeg/config-v1":
            self.counts["config"] += 1
            self._logline("config: labels=%s expRate=%s units=%s calib=%s clearGate=%s"
                          % (msg.get("channelLabels"), msg.get("expectedHardwareSampleRateHz"),
                             msg.get("units"), msg.get("calibrationStatus"), msg.get("clearStateEnabled")))
        elif t == "eeg/raw-v1":
            self.counts["raw"] += 1
            self.counts["samples"] += int(msg.get("sampleCount") or 0)
            cont = msg.get("continuity") or {}
            if cont.get("sdkCallbackGapEstimate"):
                self.counts["gaps"] += 1
                self._logline("gap (inferred): estMissing=%s at rawBatch=%s"
                              % (cont.get("estimatedMissingSamples"), self.counts["raw"]))
        elif t == "eeg/quality-v1":
            self.counts["quality"] += 1

    def annotate(self, kind, t=None, note=None):
        """A staff event annotation (blink, swallow, L-out, disconnect, …). NOT a classifier."""
        if not self.enabled:
            return
        entry = {
            "kind": kind,
            "wallMs": int(t if isinstance(t, (int, float)) else time.time() * 1000),
            "monotonicMs": round((time.monotonic() - self.started_mono) * 1000, 1),
            "rawBatchIndex": self.counts["raw"],
            "sampleIndexApprox": self.counts["samples"],
            "note": note,
        }
        self.annotations.append(entry)
        self._logline("ANNOTATION %s @ rawBatch=%s ~sample=%s%s"
                      % (kind, entry["rawBatchIndex"], entry["sampleIndexApprox"], (" — " + note) if note else ""))

    def _logline(self, s):
        if not self._log_f:
            return
        try:
            self._log_f.write(time.strftime("%H:%M:%S ") + s + "\n")
            self._log_f.flush()
        except Exception:
            pass

    def close(self, reason="close"):
        """Flush a metadata summary + close the files cleanly (stop/disconnect/exit)."""
        if not self.enabled:
            return
        self.enabled = False
        meta = {
            "capture": "engineering-validation", "phase": "2A.2",
            "simulation": self.simulation, "closeReason": reason,
            "startedWallMs": int(self.started_wall * 1000),
            "durationSec": round(time.monotonic() - self.started_mono, 1),
            "counts": self.counts, "annotations": self.annotations,
            "files": {"raw": os.path.basename(self.raw_path), "log": os.path.basename(self.log_path)},
            "note": ("ORIGINAL raw ADC counts preserved (not filtered/decimated). Local only; "
                     "never uploaded; production retention unchanged. Annotations are staff "
                     "event marks for inspection, NOT a validated classifier."),
        }
        try:
            with open(self.meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=1)
        except Exception as e:
            self.log(f"validation meta write failed: {e}")
        self._logline("VALIDATION CAPTURE CLOSE (%s) — rawBatches=%s samples=%s quality=%s gaps=%s annotations=%s"
                      % (reason, self.counts["raw"], self.counts["samples"], self.counts["quality"],
                         self.counts["gaps"], len(self.annotations)))
        for f in (self._raw_f, self._log_f):
            try:
                if f:
                    f.close()
            except Exception:
                pass
        self._raw_f = self._log_f = None
