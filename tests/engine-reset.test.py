"""S3 proof — EngagementEngine.reset() gives guest 2 a genuinely fresh session.

Plain script, no framework. Feeds a synthetic session until the plateau fires,
resets, feeds a second session (a whole hour later on the wall clock) and
asserts it starts fresh: tRel near 0, empty sample buffer, plateau able to fire
again — while signal quality (link state, not session state) survives the reset.

Run (Windows):  venv\\Scripts\\python tests\\engine-reset.test.py   (exit 0 = pass)
Run (macOS):    venv/bin/python tests/engine-reset.test.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sidecar"))

from engine import EngagementEngine  # noqa: E402

failures = []
checks = 0


def check(name, cond, detail=""):
    global checks
    checks += 1
    tag = "ok  " if cond else "FAIL"
    print(f"[{tag}] {name}" + (f" — {detail}" if detail else ""))
    if not cond:
        failures.append(name)


def run_session(engine, t0_ms, seconds=60):
    """Feed 5Hz raw engagement: a low cold-start, then a held high plateau —
    deterministic, so the plateau detector must fire every session."""
    frames = []
    for i in range(int(seconds * 5)):
        te = i * 0.2
        raw = 0.2 if te < 5.0 else 0.8
        frame = engine.feed(raw, t0_ms + i * 200)
        if frame is not None:
            frames.append(frame)
    return frames


engine = EngagementEngine()
engine.set_signal_quality(0.42)

# ---- guest 1 ----
frames1 = run_session(engine, t0_ms=1_000_000)
check("session 1 emitted frames", len(frames1) >= 30, f"{len(frames1)} frames")
check("session 1 recorded samples", len(engine.samples) >= 30, f"{len(engine.samples)} samples")
check("session 1 plateau fired", engine.plateau_fired)
check("session 1 time advanced", engine.samples[-1]["t"] > 50,
      f"last t={engine.samples[-1]['t']}")

# ---- the reset ----
engine.reset()
check("reset cleared samples", engine.samples == [])
check("reset cleared t0", engine._t0 is None)
check("reset cleared plateau latch", engine.plateau_fired is False)
check("reset cleared dip count", engine.dip_count == 0)
check("reset cleared band seeds",
      engine._band_init is False and engine._lo is None and engine._hi is None)
check("reset kept signal quality", abs(engine._signal_quality - 0.42) < 1e-9,
      f"q={engine._signal_quality}")

# ---- guest 2, an hour later — must look like t=0, not t=3660s ----
frames2 = run_session(engine, t0_ms=1_000_000 + 3_600_000)
check("session 2 emitted frames", len(frames2) >= 30, f"{len(frames2)} frames")
check("session 2 tRel starts near 0", frames2[0]["tRel"] < 2.0,
      f"first tRel={frames2[0]['tRel']}")
check("session 2 first sample t near 0", engine.samples[0]["t"] < 2.0,
      f"t={engine.samples[0]['t']}")
check("session 2 plateau fired again", engine.plateau_fired)
check("session 2 buffer holds one session only", len(engine.samples) <= len(frames2),
      f"{len(engine.samples)} samples vs {len(frames2)} frames")

if failures:
    print(f"\n{len(failures)}/{checks} check(s) FAILED: {failures}")
    sys.exit(1)
print(f"\nall {checks} checks passed")
sys.exit(0)
