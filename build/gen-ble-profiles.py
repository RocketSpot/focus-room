#!/usr/bin/env python3
"""uuid-catalogue-to-json.py — convert an engineering UUID catalogue (.xlsx)
into the sidecar's ble_profiles.json shape.

    python build/gen-ble-profiles.py <catalogue.xlsx> <out.json>

The xlsx layout (from engineering): rows of
    [Earbud number N | Left/Right | Service/RX/TX | "0xAAAAAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEEEEEEEEEE"]
with the earbud number and side carried down merged cells. Output:
    {"zone_eeg": {"Earbud_N": {"Serial_Number": ..., "Left_Service_UUID": ..., ...}}}

The converter VALIDATES before it writes: 5 sections shaped 8-4-4-4-12, hex
only, six UUIDs per pair, global uniqueness, and no collisions with the
Bluetooth-SIG base, Nordic UART, or DFU service IDs the prober must be able
to trust. A catalogue that fails validation is rejected loudly — a wrong
identifier table is worse than the old one.
"""
import sys, re, json
import openpyxl

SIG_SUFFIX = "-0000-1000-8000-00805f9b34fb"
RESERVED = {
    "6e400001-b5a3-f393-e0a9-e50e24dcca9e",  # Nordic UART service
    "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
    "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
    "00001530-1212-efde-1523-785feabcd123",  # Nordic legacy DFU
    "8ec90001-f315-4f60-9fb8-838830daea50",  # Nordic buttonless secure DFU
}
LENS = (8, 4, 4, 4, 12)
HEX = re.compile(r"^[0-9a-f]+$")


def parse(path):
    ws = openpyxl.load_workbook(path, data_only=True).worksheets[0]
    buds, cur, side, problems = {}, None, None, []
    for row in ws.iter_rows(values_only=True):
        a, b, c, d = (list(row) + [None] * 4)[:4]
        if a: cur = str(a).strip()
        if b: side = str(b).strip()
        if not c or not d: continue
        segs = []
        for p in [x.strip() for x in str(d).split(",")]:
            if not p.lower().startswith("0x"):
                problems.append(f"{cur}/{side}/{c}: section without 0x: {p}")
                continue
            segs.append(p[2:].lower())
        if len(segs) != 5:
            problems.append(f"{cur}/{side}/{c}: {len(segs)} sections (need 5)")
            continue
        for s, L in zip(segs, LENS):
            if len(s) != L or not HEX.match(s):
                problems.append(f"{cur}/{side}/{c}: bad section {s!r} (need {L} hex chars)")
        u = "-".join(segs)
        if u.endswith(SIG_SUFFIX) or u in RESERVED:
            problems.append(f"{cur}/{side}/{c}: collides with a reserved BLE id")
        buds.setdefault(cur, {})[f"{side}_{str(c).strip()}"] = u
    return buds, problems


def main():
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(2)
    src, out = sys.argv[1], sys.argv[2]
    buds, problems = parse(src)
    allu = [u for b in buds.values() for u in b.values()]
    if len(set(allu)) != len(allu):
        problems.append("duplicate UUIDs inside the catalogue")
    incomplete = [k for k, v in buds.items() if len(v) != 6]
    if incomplete:
        problems.append(f"pairs without all six UUIDs: {incomplete[:5]}")
    if problems:
        print(f"REJECTED — {len(problems)} problem(s):")
        for p in problems[:20]: print("  !", p)
        sys.exit(1)

    zone = {}
    for serial, v in buds.items():
        m = re.search(r"(\d+)", serial)
        key = f"Earbud_{m.group(1)}" if m else serial.replace(" ", "_")
        zone[key] = {
            "Serial_Number": serial,
            "Left_Service_UUID": v["Left_Service"],
            "Left_RX_UUID": v["Left_RX"],
            "Left_TX_UUID": v["Left_TX"],
            "Right_Service_UUID": v["Right_Service"],
            "Right_RX_UUID": v["Right_RX"],
            "Right_TX_UUID": v["Right_TX"],
        }
    with open(out, "w") as f:
        json.dump({"zone_eeg": zone}, f, indent=1)
    fams = sorted({u.split("-")[0] for u in allu})
    print(f"OK  {out}: {len(zone)} pairs, {len(allu)} UUIDs, family {fams}")


if __name__ == "__main__":
    main()
