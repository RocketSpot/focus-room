#!/usr/bin/env python3
"""Point a Zone bud at the new pipeline, from any laptop, in about two minutes.

WHY THIS EXISTS
---------------
The room's DSP has been rebuilt, but every number proving it works so far comes
from synthetic signals. The one real recording in the repo predates the work and
was classed unusable. So the honest status is: the pipeline is correct on models
of EEG, and untested on a brain.

This closes that gap without needing the installation machine. The earbuds talk
BLE, which is a same-room radio, so the Mac mini cannot be driven from
elsewhere. But the question is not "does the room run", it is "does the
measurement work", and a bud plus this script answers that anywhere.

THE TEST: Berger's alpha block. Sit still with your eyes OPEN for half a minute,
then CLOSED for half a minute. Occipital alpha rises sharply when the eyes
close. It is the oldest and most reliable effect in EEG, it needs no baseline
calibration, and nothing about the electrodes, the filter or the fit changes
between the two windows. Only the brain does. If alpha rises, the pipeline is
measuring one. If it does not, nothing else in the rebuild matters yet.

At the ear the effect is smaller than at the scalp, so treat 2 dB as a pass,
1 to 2 dB as suggestive, and below that as not demonstrated.

RUN
    python3 tools/bud-check.py                 # auto-detect the bud
    python3 tools/bud-check.py --seconds 45    # longer windows, tighter result

It writes the raw counts to data/validation/bud-check-*.json so the recording
can be re-analysed later, offline, without the hardware present.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "sidecar"))

# Both UUID families seen in the field. The room's own catalogue currently
# probes only the efaecafe family, so a bud built to either 2fda set will not
# connect to the installation today. That is worth knowing on its own, and this
# script reports which one answered.
FAMILIES = {
    "bud-33": {
        "left":  {"tx": "00000000-2fda-0000-0000-000000000243", "rx": "00000000-2fda-0000-0000-000000000242"},
        "right": {"tx": "00000000-2fda-0000-0000-00000000024c", "rx": "00000000-2fda-0000-0000-00000000024b"},
    },
    "bud-35": {
        "left":  {"tx": "00000000-2fda-0000-0000-000000000267", "rx": "00000000-2fda-0000-0000-000000000266"},
        "right": {"tx": "00000000-2fda-0000-0000-000000000270", "rx": "00000000-2fda-0000-0000-00000000026f"},
    },
}

FS = 250.0


def die(msg, hint=""):
    print(f"\n  {msg}")
    if hint:
        print(f"  {hint}")
    sys.exit(1)


try:
    import numpy as np
except Exception:
    die("numpy is not installed.", "pip3 install numpy scipy bleak")
try:
    from bleak import BleakScanner, BleakClient
except Exception:
    die("bleak is not installed.", "pip3 install numpy scipy bleak")
try:
    import spectral as S
except Exception as e:
    die(f"could not import the room's DSP ({e}).",
        "Run this from inside a clone of the focus-room repo.")


def decode(payload, sink):
    """Both packet layouts, 9-byte legacy and 11-byte with lead-off."""
    n = len(payload)
    i = 0
    while i < n:
        matched = False
        for size in (11, 9):
            if i + size <= n and payload[i] == 0xA0 and payload[i + size - 1] == 0xC0:
                p = payload[i:i + size]
                for ch, off in ((0, 2), (1, 5)):
                    v = (p[off] << 16) | (p[off + 1] << 8) | p[off + 2]
                    if v & 0x800000:
                        v -= 1 << 24
                    sink[ch].append(float(v))
                if size == 11:
                    sink["loff"].append((p[8], p[9]))
                i += size
                matched = True
                break
        if not matched:
            i += 1


async def find_bud(timeout=8.0):
    print(f"  scanning for {timeout:.0f}s ...")
    devs = await BleakScanner.discover(timeout=timeout)
    hits = [d for d in devs if (d.name or "").lower().find("zone") >= 0]
    if not hits:
        names = ", ".join(sorted({d.name for d in devs if d.name})[:8]) or "nothing named"
        die("no Zone bud found.",
            f"Is it on and out of its case? Nearby devices: {names}")
    for d in hits:
        print(f"    found {d.name}  {d.address}")
    return hits[0]


async def capture(seconds):
    dev = await find_bud()
    sink = {0: [], 1: [], "loff": []}
    marks = {}

    def on_notify(_sender, data):
        decode(bytes(data), sink)

    client = BleakClient(dev.address, timeout=20.0)
    await client.connect()
    if not client.is_connected:
        die("the bud would not connect.")
    print(f"  connected to {dev.name}")

    used = None
    for fam, sides in FAMILIES.items():
        for side, u in sides.items():
            try:
                await client.start_notify(u["tx"], on_notify)
                await client.write_gatt_char(u["rx"], b"b", response=False)
                await asyncio.sleep(1.2)
                if len(sink[0]) > 40:
                    used = (fam, side, u)
                    break
                await client.stop_notify(u["tx"])
            except Exception:
                continue
        if used:
            break
    if not used:
        await client.disconnect()
        die("connected, but no EEG arrived on any known characteristic.",
            "The firmware may use a different UUID family than either GUI script.")
    fam, side, u = used
    print(f"  streaming: {fam}, {side} characteristics\n")

    async def window(label, instruction):
        print(f"  >>> {instruction}")
        for n in (3, 2, 1):
            print(f"      starting in {n} ...", end="\r", flush=True)
            await asyncio.sleep(1)
        start = len(sink[0])
        t0 = time.monotonic()
        while time.monotonic() - t0 < seconds:
            left = seconds - (time.monotonic() - t0)
            print(f"      {label}: {left:4.0f}s left, {len(sink[0]) - start} samples   ",
                  end="\r", flush=True)
            await asyncio.sleep(0.5)
        marks[label] = (start, len(sink[0]))
        print(f"      {label}: done, {marks[label][1] - start} samples            ")

    await window("open", "EYES OPEN. Sit still, look at one spot, breathe normally.")
    print()
    await window("closed", "EYES CLOSED now. Stay still, stay awake.")

    try:
        await client.write_gatt_char(u["rx"], b"s", response=False)
    except Exception:
        pass
    await client.disconnect()
    return sink, marks, (fam, side, dev.name)


def analyse(sink, marks):
    out = {}
    for label, (a, b) in marks.items():
        chans = [np.asarray(sink[c][a:b], dtype=np.float64) for c in (0, 1)]
        n = min(len(c) for c in chans)
        if n < int(FS * 6):
            print(f"  {label}: only {n} samples, too short to measure")
            return None
        chans = np.vstack([c[:n] for c in chans])
        # a few overlapping windows, then the median, so one twitch cannot carry it
        step = int(FS * 2)
        win = int(FS * 6)
        rows = []
        for s in range(0, n - win + 1, step):
            r = S.analyse_window(chans[:, s:s + win], fs=FS)
            if r["ok"]:
                rows.append(r)
        if not rows:
            print(f"  {label}: no window produced a usable fit")
            return None
        out[label] = {
            "osc": {k: float(np.median([r["osc"][k] for r in rows])) for k in S.BAND_ORDER},
            "chi": float(np.median([r["aperiodic"]["exponent"] for r in rows])),
            "windows": len(rows),
        }
    return out


def report(res, meta, sink, marks, seconds):
    print("\n" + "=" * 62)
    print("  OSCILLATORY PROMINENCE, dB above your own 1/f background")
    print("=" * 62)
    print(f"  {'band':<8}{'eyes open':>12}{'eyes closed':>14}{'change':>10}")
    for k in S.BAND_ORDER:
        o, c = res["open"]["osc"][k], res["closed"]["osc"][k]
        print(f"  {k:<8}{o:>+12.2f}{c:>+14.2f}{c - o:>+10.2f}")
    d = res["closed"]["osc"]["alpha"] - res["open"]["osc"]["alpha"]
    print(f"\n  1/f exponent: {res['open']['chi']:.2f} open, {res['closed']['chi']:.2f} closed")
    print(f"  windows measured: {res['open']['windows']} open, {res['closed']['windows']} closed")
    print("\n" + "-" * 62)
    if d >= 2.0:
        print(f"  ALPHA ROSE {d:+.2f} dB WITH YOUR EYES CLOSED.")
        print("  That is Berger's effect, and it is the pipeline measuring a brain.")
    elif d >= 1.0:
        print(f"  Alpha rose {d:+.2f} dB. Suggestive, but under the 2 dB bar.")
        print("  Worth a longer run before calling it: --seconds 60")
    else:
        print(f"  Alpha changed {d:+.2f} dB, which does not demonstrate the effect.")
        print("  That is a real result, not a failure of the script. Likely causes,")
        print("  in order: the bud not seated firmly, too much movement, or the")
        print("  montage genuinely not picking up occipital alpha at this ear.")
    print("-" * 62)
    # delta is the number that started all this
    dm = max(res["open"]["osc"]["delta"], res["closed"]["osc"]["delta"])
    print(f"\n  Delta peaked at {dm:+.2f} dB across both windows.")
    print("  On the old statistic an awake reader measured 77% delta. Anything")
    print("  under about 1.5 dB here means that failure mode is gone on real data.")

    out_dir = os.path.join(ROOT, "data", "validation")
    os.makedirs(out_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = os.path.join(out_dir, f"bud-check-{stamp}.json")
    with open(path, "w") as f:
        json.dump({
            "recordedAt": stamp, "device": meta[2], "uuidFamily": meta[0], "side": meta[1],
            "sampleRateAssumed": FS, "secondsPerWindow": seconds,
            "note": "raw ADC counts, never microvolts: the calibration is unverified",
            "marks": {k: list(v) for k, v in marks.items()},
            "channels": {"ch1": sink[0], "ch2": sink[1]},
            "leadOffSeen": len(sink["loff"]) > 0,
            "result": res,
        }, f)
    os.chmod(path, 0o600)
    print(f"\n  raw recording saved: {path}")
    print("  Send me that file and the pipeline can be re-run on it offline,")
    print("  as many times as we like, without the buds present.")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=30.0, help="per window (default 30)")
    args = ap.parse_args()

    print("\n  Zone bud check: does the new pipeline measure a brain?")
    print("  ------------------------------------------------------")
    print("  Put ONE bud in, firmly. Sit somewhere quiet where you can stay")
    print("  still for about a minute and a half. Nothing here is stored")
    print("  anywhere but your own machine.\n")
    sink, marks, meta = await capture(args.seconds)
    if len(sink["loff"]):
        print("\n  (this firmware sends lead-off bits, so live contact sensing works)")
    res = analyse(sink, marks)
    if res:
        report(res, meta, sink, marks, args.seconds)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  stopped.")
