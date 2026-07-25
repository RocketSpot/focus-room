"""Local validation-mode recorder (Phase 2A.2, section 4) — OFF unless FOCUSROOM_VALIDATION=1.

An EXPLICIT, opt-in engineering recorder for the real-hardware validation run. It taps the
three raw messages (``eeg/config-v1``, ``eeg/raw-v1``, ``eeg/quality-v1``) plus timing/
continuity metadata and staff event annotations, and writes them to LOCAL files only:

  * ``<ts>_<label>.raw.ndjson`` — the raw stream, one JSON object per line. Preserves the
    ORIGINAL raw ADC counts (never filtered or decimated display data).
  * ``<ts>_<label>.meta.json``  — capture metadata + counters + staff annotations.
  * ``<ts>_<label>.log.txt``    — a human-readable validation log.

DISCIPLINE (matches the user's section-4 + pre-merge-hardening requirements):
  * Records ONLY because validation mode was explicitly enabled (env FOCUSROOM_VALIDATION=1).
  * NEVER uploads raw EEG to analytics or any cloud service — local files only.
  * Does NOT change normal production retention (this is a separate, opt-in path).
  * Writes to a LOCAL, access-restricted (0700), NON-synchronized app-data directory by default
    (never the repo/cwd/Documents/Desktop/iCloud/Dropbox); FOCUSROOM_VALIDATION_DIR overrides.
  * NO participant names or unnecessary identifiers in filenames or metadata (fixed label set).
  * Clearly labels the capture as engineering validation data; carries a retention/deletion policy.
  * Closes/flushes the files cleanly on stop, disconnect, or application exit.

Pure stdlib; time.* is fine here (this is the app sidecar, not a restricted sandbox).
"""

import json
import os
import sys
import time


def enabled():
    return os.environ.get("FOCUSROOM_VALIDATION") == "1"


# item 4: annotation kinds are restricted to a fixed, NON-identifying vocabulary so a stray
# operator label (or anything name-like) can NEVER land in the metadata/log. Anything outside
# the set is recorded as the generic "marker"; free-form notes are not recorded at all.
_SAFE_KINDS = {
    "still", "start", "end", "stability", "blink", "blinks", "eye_closure", "swallow",
    "jaw", "jaw_clench", "clench", "head_turn", "head_left", "head_right", "look_down",
    "center", "earbud_adjust", "reseat", "channel_disturb", "interruption", "marker",
    "ear_left_out", "ear_left_in", "ear_right_out", "ear_right_in",
    "l_out", "l_in", "r_out", "r_in", "disconnect", "reconnect", "recovery",
}


def _safe_kind(kind):
    k = "".join(c for c in str(kind or "").strip().lower() if c.isalnum() or c in "_-")[:24]
    return k if k in _SAFE_KINDS else "marker"


def _default_dir():
    """A LOCAL, access-restricted, NON-synchronized default location for captures.

    Never the repo, the cwd, or a cloud-synced folder (Documents / Desktop / iCloud /
    Dropbox / OneDrive). Uses the OS's per-user application-data area (matches the app's
    ``zone-focus-room`` support name). The launcher may override with FOCUSROOM_VALIDATION_DIR
    (e.g. an operator-vetted encrypted volume).
    """
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support", "zone-focus-room")
    elif os.name == "nt":
        base = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local"),
                            "zone-focus-room")
    else:
        base = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share"),
                            "zone-focus-room")
    return os.path.join(base, "validation-captures")


class ValidationRecorder:
    def __init__(self, session_label, simulation, log=None):
        self.log = log or (lambda *_: None)
        self.simulation = bool(simulation)
        self.enabled = False
        self.counts = {"config": 0, "raw": 0, "quality": 0, "samples": 0, "gaps": 0}
        self.annotations = []
        self._raw_f = self._log_f = None
        base = os.environ.get("FOCUSROOM_VALIDATION_DIR") or _default_dir()
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        # item 4: filenames + metadata must NEVER carry a participant name or any unnecessary
        # identifier. The label is restricted to a fixed, non-identifying set.
        safe = str(session_label or "").strip().lower()
        label = safe if safe in ("sim", "real") else "session"
        try:
            os.makedirs(base, exist_ok=True)
            try:
                os.chmod(base, 0o700)          # item 3: access-restricted (best-effort; Windows ACLs differ)
            except Exception:
                pass
            self.stem = os.path.join(base, f"{stamp}_{label}")
            self.raw_path = self.stem + ".raw.ndjson"
            self.meta_path = self.stem + ".meta.json"
            self.log_path = self.stem + ".log.txt"
            self._raw_f = open(self.raw_path, "w", encoding="utf-8")
            self._log_f = open(self.log_path, "w", encoding="utf-8")
            for _pth in (self.raw_path, self.log_path):   # item 3: restrict the files too (0600)
                try:
                    os.chmod(_pth, 0o600)
                except Exception:
                    pass
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
        """A staff event annotation (blink, swallow, L-out, disconnect, …). NOT a classifier.

        item 4: the kind is reduced to a fixed NON-identifying vocabulary (unknown → "marker")
        and any free-form note is DROPPED, so no participant identifier can enter the record.
        """
        if not self.enabled:
            return
        entry = {
            "kind": _safe_kind(kind),
            "wallMs": int(t if isinstance(t, (int, float)) else time.time() * 1000),
            "monotonicMs": round((time.monotonic() - self.started_mono) * 1000, 1),
            "rawBatchIndex": self.counts["raw"],
            "sampleIndexApprox": self.counts["samples"],
        }
        self.annotations.append(entry)
        self._logline("ANNOTATION %s @ rawBatch=%s ~sample=%s"
                      % (entry["kind"], entry["rawBatchIndex"], entry["sampleIndexApprox"]))

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
            "containsParticipantIdentifiers": False,   # item 4: no names / identifiers recorded
            "retentionPolicy": ("Engineering validation data. Retain only as long as needed for the "
                                "validation review, then delete. Stored LOCAL + access-restricted "
                                "(0700), never synced or uploaded. No participant identifiers are "
                                "recorded; the filename label is a fixed non-identifying token."),
            "note": ("ORIGINAL raw ADC counts preserved (not filtered/decimated). Local only; "
                     "never uploaded; production retention unchanged. Annotations are staff "
                     "event marks for inspection, NOT a validated classifier."),
        }
        try:
            with open(self.meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=1)
            try:
                os.chmod(self.meta_path, 0o600)          # item 3: restrict the metadata file too
            except Exception:
                pass
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
