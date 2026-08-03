"""Lead-off contact decoding, both packet layouts.

The firmware ships two packet shapes and the room only understood one:

    legacy   9 bytes : [0xA0][seq][CH1 x3][CH2 x3][0xC0]
    current 11 bytes : [0xA0][seq][CH1 x3][CH2 x3][LOFF_P][LOFF_N][0xC0]

BLE_PACKET_SIZE was fixed at 9, so the two lead-off bytes were unreachable and
electrode contact could only be judged before a session, by the Goertzel
impedance check, which injects a current and so cannot run while streaming. The
inline bits ride along on samples that were arriving anyway, which is what makes
live contact sensing possible during a reading at all.

This test drives the REAL parser with synthetic packets, since the hardware is
not available. It asserts both layouts decode, that neither is misread as the
other, and that the sample values survive identically either way.

Run:  venv/bin/python tests/eeg-leadoff.test.py
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "sidecar"))

_pass = 0
_fail = 0


def ok(name, cond, detail=""):
    global _pass, _fail
    print(("  ok   " if cond else " FAIL  ") + name + ("" if cond else "  >> " + str(detail)))
    if cond:
        _pass += 1
    else:
        _fail += 1


try:
    from zone_sdk import connection as C
except Exception as e:                       # pragma: no cover
    print(f"  cannot import the transport ({e}); this is a broken test environment, not a skip")
    sys.exit(1)


def i24(v):
    """encode a signed 24-bit value the way the firmware does"""
    if v < 0:
        v += 1 << 24
    return bytes([(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF])


def pkt9(seq, ch1, ch2):
    return bytes([0xA0, seq]) + i24(ch1) + i24(ch2) + bytes([0xC0])


def pkt11(seq, ch1, ch2, loff_p, loff_n):
    return bytes([0xA0, seq]) + i24(ch1) + i24(ch2) + bytes([loff_p, loff_n, 0xC0])


class Probe(C.DualBLEConnection):
    """Captures what the parser produced, without touching BLE."""

    def __init__(self):
        # deliberately NOT calling super().__init__: it spins up two OS threads
        # with their own event loops, which a unit test has no business doing.
        self.seen = []
        self.loff = []
        self._leadoff_tap = lambda dev, p, n: self.loff.append((dev, p, n))

    def _process_packet(self, pkt, device_id):
        raw = (pkt[2] << 16) | (pkt[3] << 8) | pkt[4]
        if raw & 0x800000:
            raw -= 1 << 24
        raw2 = (pkt[5] << 16) | (pkt[6] << 8) | pkt[7]
        if raw2 & 0x800000:
            raw2 -= 1 << 24
        self.seen.append((pkt[1], raw, raw2, len(pkt)))
        if len(pkt) >= C.BLE_PACKET_SIZE_LOFF and self._leadoff_tap is not None:
            self._leadoff_tap(device_id, pkt[8], pkt[9])


ok("the transport declares both packet lengths",
   C.BLE_PACKET_SIZE == 9 and C.BLE_PACKET_SIZE_LOFF == 11,
   (C.BLE_PACKET_SIZE, getattr(C, "BLE_PACKET_SIZE_LOFF", None)))

# --- legacy stream, unchanged behaviour ---
p = Probe()
stream = b"".join(pkt9(i, 1000 + i, -2000 - i) for i in range(5))
p._parse_packets(bytearray(stream), 1)
ok("a legacy 9-byte stream still decodes every packet", len(p.seen) == 5, p.seen)
ok("legacy sample values are exact",
   p.seen[0][1] == 1000 and p.seen[0][2] == -2000, p.seen[0])
ok("legacy packets produce no lead-off reports", len(p.loff) == 0, p.loff)

# --- current stream, with lead-off ---
p = Probe()
stream = b"".join(pkt11(i, 1000 + i, -2000 - i, 0b01, 0b10) for i in range(5))
p._parse_packets(bytearray(stream), 2)
ok("an 11-byte stream decodes every packet", len(p.seen) == 5, p.seen)
ok("11-byte packets are NOT misread as 9-byte ones",
   all(x[3] == 11 for x in p.seen), p.seen)
ok("sample values are identical to the legacy layout",
   p.seen[0][1] == 1000 and p.seen[0][2] == -2000, p.seen[0])
ok("lead-off bits reach the tap on every sample", len(p.loff) == 5, p.loff)
ok("lead-off bits carry through unchanged",
   p.loff[0] == (2, 0b01, 0b10), p.loff[0])

# --- a mixed stream, which is what a firmware change mid-session looks like ---
p = Probe()
stream = pkt9(1, 11, 22) + pkt11(2, 33, 44, 0b11, 0b00) + pkt9(3, 55, 66)
p._parse_packets(bytearray(stream), 1)
ok("a mixed stream decodes all three packets", len(p.seen) == 3, p.seen)
ok("each packet keeps its own length", [x[3] for x in p.seen] == [9, 11, 9], p.seen)
ok("only the long packet reports contact", len(p.loff) == 1, p.loff)

# --- garbage in front must not desynchronise the parser ---
p = Probe()
stream = b"\x12\x34\x56" + b"".join(pkt11(i, i, -i, 0, 0) for i in range(4))
p._parse_packets(bytearray(stream), 1)
ok("leading garbage is skipped, not misaligned into", len(p.seen) == 4, p.seen)

# --- the decode the operator actually sees ---
# a SET bit means that pin is OFF the skin
def contact(loff_p, loff_n):
    out = {}
    for ch in (0, 1):
        off_p = bool((loff_p >> ch) & 1)
        off_n = bool((loff_n >> ch) & 1)
        out[f"ch{ch + 1}"] = {"p": not off_p, "n": not off_n, "off": bool(off_p or off_n)}
    return out


c = contact(0b00, 0b00)
ok("all bits clear reads as both channels in contact",
   not c["ch1"]["off"] and not c["ch2"]["off"], c)
c = contact(0b01, 0b00)
ok("a set P bit on channel 1 marks only channel 1 off",
   c["ch1"]["off"] and not c["ch2"]["off"], c)
c = contact(0b11, 0b11)
ok("all bits set marks the whole bud off the skin",
   c["ch1"]["off"] and c["ch2"]["off"], c)

print("\n" + ("all %d checks passed" % _pass if _fail == 0 else "%d FAILURE(S)" % _fail))
sys.exit(0 if _fail == 0 else 1)
