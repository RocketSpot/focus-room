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

# No hardcoded UUIDs. An earlier version tried four characteristic pairs lifted
# from two GUI scripts (buds 33 and 35 of the 2fda family) — but in both known
# families every bud serial gets DIFFERENT characteristic IDs, so any other bud
# connected and then streamed nothing. This script now does what the room's own
# sidecar does: open the live GATT table and pick the notify(data)/write(command)
# pair, preferring known Zone families but accepting any vendor service that
# fits. It still reports which family answered, which is worth knowing on its own.
SIG_BASE_SUFFIX = "-0000-1000-8000-00805f9b34fb"   # standard services (battery, device-info)
DFU_SERVICES = {                                   # firmware-update services that would
    "00001530-1212-efde-1523-785feabcd123",        # otherwise look like notify+write pairs
    "8ec90001-f315-4f60-9fb8-838830daea50",
    "fe59",
}
NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
ZONE_EEG_PREFIXES = ("00000000-2fda-", "efaecafe-")

FS = 250.0


def family_of(service_uuid):
    if service_uuid.startswith("00000000-2fda-"):
        return "2fda (legacy GUI-script family)"
    if service_uuid.startswith("efaecafe-"):
        return "efaecafe (July 2026 engineering catalogue)"
    if service_uuid == NUS_SERVICE:
        return "Nordic UART"
    return "unrecognised vendor service"


def rank_candidates(services):
    """The sidecar's discovery logic, standalone: every plausible EEG service,
    best first. Prefer a Zone-family service with separate notify and write
    characteristics; fall back to any vendor service that has both roles."""
    ranked = []
    for s in services:
        su = str(s.uuid).lower()
        if su.endswith(SIG_BASE_SUFFIX) or su in DFU_SERVICES:
            continue
        chars = list(s.characteristics)
        notify = [c for c in chars
                  if any(p in c.properties for p in ("notify", "indicate"))]
        writes = [c for c in chars
                  if any(p in c.properties for p in ("write", "write-without-response"))]
        if not notify or not writes:
            continue
        tx = next((c for c in notify
                   if not any(p in c.properties for p in ("write", "write-without-response"))),
                  notify[0])
        cmd_only = [c for c in writes
                    if not any(p in c.properties for p in ("notify", "indicate"))]
        pool = cmd_only or writes
        rx = next((c for c in pool if "write-without-response" in c.properties), pool[0])
        disjoint = str(tx.uuid) != str(rx.uuid)
        zone = su.startswith(ZONE_EEG_PREFIXES)
        tier = 0 if (zone and disjoint) else 1 if disjoint else 2 if zone else 3
        ranked.append((tier, su, {
            "service": su, "rx": str(rx.uuid).lower(), "tx": str(tx.uuid).lower(),
            "notify": [str(c.uuid).lower() for c in notify],
        }))
    ranked.sort(key=lambda r: (r[0], r[1]))
    return [t for _, _, t in ranked]


def dump_gatt(services):
    print("\n  the bud's full GATT table (ground truth for engineering):")
    for s in services:
        su = str(s.uuid).lower()
        note = ""
        if su.endswith(SIG_BASE_SUFFIX):
            note = "  (standard)"
        elif su in DFU_SERVICES:
            note = "  (firmware update)"
        print(f"    service {su}{note}")
        for c in s.characteristics:
            print(f"      {str(c.uuid).lower()}  {'/'.join(c.properties)}")


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
from scipy import signal as _sig

# Nominal ADC scale. The calibration chain is unverified, so nothing guest-facing
# is ever printed in uV — but a coarse "tens vs thousands" contact check is fine.
UV_PER_COUNT = 0.02235


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

    try:
        await client.get_services()
    except Exception:
        pass
    services = list(client.services)
    cands = rank_candidates(services)
    if not cands:
        dump_gatt(services)
        await client.disconnect()
        die("connected, but the bud exposes no notify+write service at all.",
            "The table above is the bud's real GATT — send it to engineering.")

    u = None
    for cand in cands:
        subs = []
        for cu in cand["notify"]:
            try:
                await client.start_notify(cu, on_notify)
                subs.append(cu)
            except Exception:
                continue
        if not subs:
            continue
        sink[0].clear(); sink[1].clear(); sink["loff"].clear()
        try:
            # the SDK's real start sequence: reset, defaults, begin
            for cmd in (b"v", b"d", b"b"):
                await client.write_gatt_char(cand["rx"], cmd, response=False)
                await asyncio.sleep(0.05)
        except Exception:
            pass
        await asyncio.sleep(1.5)
        if len(sink[0]) > 40:
            u = cand
            break
        try:
            await client.write_gatt_char(cand["rx"], b"s", response=False)
        except Exception:
            pass
        for cu in subs:
            try:
                await client.stop_notify(cu)
            except Exception:
                pass
    if not u:
        dump_gatt(services)
        await client.disconnect()
        die("connected, but no candidate service produced decodable EEG.",
            "The table above is the bud's real GATT — send it to engineering.")
    print(f"  streaming: {u['service']}")
    print(f"  family: {family_of(u['service'])}\n")

    # The buds arrive with the ADS1299 lead-off contact-check current ARMED, and
    # the firmware leaves it running until something says stop. On a real ear
    # that injected current painted a harmonic comb — 5/10/15/20 Hz lines up to
    # +19 dB — straight through theta, alpha and beta: the first in-ear run
    # measured the 10 Hz harmonic as "alpha" and Berger's test was unwinnable.
    # The room disarms it before every reading (zone.py, 'lead0'); same here.
    disarmed = False
    try:
        await client.write_gatt_char(u["rx"], b"lead0", response=False)
        disarmed = True
    except Exception:
        print("  could not send lead0 — expect excitation lines in the result")
    await asyncio.sleep(1.0)
    sink[0].clear(); sink[1].clear(); sink["loff"].clear()

    async def inband_rms(seconds=3.0):
        """In-band (2-45 Hz) level over a short grab, in nominal uV. Seated dry
        electrodes read tens at most; an unseated bud reads hundreds up."""
        s0 = len(sink[0])
        await asyncio.sleep(seconds)
        chans = [np.asarray(sink[c][s0:], dtype=np.float64) for c in (0, 1)]
        n = min(len(c) for c in chans)
        if n < int(FS * 2):
            return None
        sos = _sig.butter(4, [2.0, 45.0], btype="bandpass", fs=FS, output="sos")
        vals = []
        for c in chans:
            x = (c[:n] - np.median(c[:n])) * UV_PER_COUNT
            vals.append(float(np.sqrt(np.mean(_sig.sosfiltfilt(sos, x) ** 2))))
        return max(vals)

    contact = None
    for _ in range(3):
        contact = await inband_rms()
        if contact is not None and contact < 60.0:
            print(f"  contact looks plausible (~{contact:.0f} in-band)")
            break
        lvl = "no samples" if contact is None else f"~{contact:.0f}"
        print(f"  in-band level {lvl} — seated electrodes read tens, not that.")
        print("  Reseat the bud (twist it snug), then hold still ...")
        await asyncio.sleep(4.0)
    else:
        print("  still high — continuing, but expect windows to be rejected.")

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
    name = dev.name or ""
    side = "left" if "left" in name.lower() else "right" if "right" in name.lower() else "unknown"
    return sink, marks, {
        "device": name, "side": side, "family": family_of(u["service"]),
        "service": u["service"], "rx": u["rx"], "tx": u["tx"],
        "leadOffDisarmSent": disarmed, "contactInbandRmsUv": contact,
    }


def comb_excess_db(x):
    """Height of the worst 5/10/15 Hz excitation line above its spectral
    neighbours, in dB. Anything big means lead-off injection was live."""
    x = np.asarray(x, dtype=np.float64)
    if x.size < int(FS * 16):
        return None
    x = (x - np.median(x)) * UV_PER_COUNT
    f, p = _sig.welch(x, fs=FS, nperseg=int(FS * 8), noverlap=int(FS * 4))
    df = f[1] - f[0]
    worst = 0.0
    for k in (1, 2, 3):
        i0 = int(round(5.0 * k / df))
        if i0 + 6 >= f.size:
            break
        nb = np.median([p[i0 - 6], p[i0 + 6]])
        worst = max(worst, 10.0 * np.log10(max(p[i0], 1e-30) / max(nb, 1e-30)))
    return worst


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

    comb = max((c for c in (comb_excess_db(sink[0][a:b])
                            for a, b in marks.values()) if c is not None),
               default=None)
    meta["combExcessDb"] = comb
    if comb is not None and comb > 6.0:
        print(f"\n  WARNING: a 5 Hz harmonic comb is present (+{comb:.0f} dB).")
        print("  That is the lead-off contact-check current, not brain. This")
        print("  firmware seems to keep injecting despite 'lead0', so the band")
        print("  numbers above are not trustworthy. Worth telling engineering.")

    out_dir = os.path.join(ROOT, "data", "validation")
    os.makedirs(out_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = os.path.join(out_dir, f"bud-check-{stamp}.json")
    with open(path, "w") as f:
        json.dump({
            "recordedAt": stamp, "device": meta["device"], "side": meta["side"],
            "uuidFamily": meta["family"], "service": meta["service"],
            "rx": meta["rx"], "tx": meta["tx"],
            "leadOffDisarmSent": meta.get("leadOffDisarmSent"),
            "contactInbandRmsUv": meta.get("contactInbandRmsUv"),
            "combExcessDb": meta.get("combExcessDb"),
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
