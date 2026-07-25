"""Zone SDK — one-shot battery readout over BLE."""

from __future__ import annotations

import asyncio
import base64
import re
import struct
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Tuple


BATTERY_MIN_V = 3.2
BATTERY_MAX_V = 4.2
# Keep-alive (`zone._keepalive_loop`) uses ``b"q"`` on the same battery RX
# characteristic; the reference path is tried first.  ``b"\\x55"`` is kept
# as a fallback for older firmware that expects the legacy query byte.
BATTERY_QUERY_BYTES: Tuple[bytes, ...] = (b"q", b"\x55")
BATTERY_RESPONSE_TIMEOUT = 2.5       # seconds (weak link under dual-connection)
BATTERY_POST_NOTIFY_DELAY = 0.05   # let WinRT settle after (re)subscribe
BATTERY_VALID_RANGE = (2.5, 4.5)   # sanity guard on parsed voltage

_VOLTAGE_RE = re.compile(rb"Voltage:\s*([\d.]+)\s*V", re.IGNORECASE)


def _noop_battery_tx(_sender, _data: bytearray) -> None:
    """No-op handler matching DualBLEConnection extra TX subscriptions."""

    return


@dataclass
class BatteryReading:
    side: str               # "left" | "right"
    voltage: float          # volts
    percentage: int         # 0..100 inclusive
    last_updated: datetime


def voltage_to_percent(v: float) -> int:
    pct = (v - BATTERY_MIN_V) / (BATTERY_MAX_V - BATTERY_MIN_V) * 100.0
    return max(0, min(100, int(round(pct))))


def _in_range(v: float) -> bool:
    lo, hi = BATTERY_VALID_RANGE
    return lo <= v <= hi


def parse_battery_payload(data: bytes) -> Optional[float]:
    """Try text → base64 → uint16 mV BE → uint16 mV LE. Return first valid voltage."""
    if not data:
        return None

    # 1. UTF-8 text "Voltage: X.XXXV"
    m = _VOLTAGE_RE.search(data)
    if m:
        try:
            v = float(m.group(1))
            if _in_range(v):
                return v
        except ValueError:
            pass

    # 2. Base64 wrapper around text
    try:
        decoded = base64.b64decode(data, validate=False)
        m = _VOLTAGE_RE.search(decoded)
        if m:
            v = float(m.group(1))
            if _in_range(v):
                return v
    except Exception:
        pass

    # 3. uint16 millivolts big-endian
    if len(data) >= 2:
        try:
            mv = struct.unpack(">H", data[:2])[0]
            v = mv / 1000.0
            if _in_range(v):
                return v
        except struct.error:
            pass

    # 4. uint16 millivolts little-endian
    if len(data) >= 2:
        try:
            mv = struct.unpack("<H", data[:2])[0]
            v = mv / 1000.0
            if _in_range(v):
                return v
        except struct.error:
            pass

    return None


class BatteryQuery:
    """One-shot battery read using an existing BleakClient connection."""

    async def _query_raw_once(
        self,
        client,
        battery_rx_uuid: str,
        battery_tx_uuid: str,
        query_byte: bytes,
    ) -> Optional[bytes]:
        """Swap in a one-shot notify handler, write ``query_byte`` to RX, return payload."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        tx = battery_tx_uuid.lower()

        def _on_notify(_sender, data: bytearray):
            if not future.done():
                future.set_result(bytes(data))

        try:
            await client.stop_notify(tx)
        except Exception:
            pass
        try:
            await client.start_notify(tx, _on_notify)
        except Exception:
            if client.is_connected:
                try:
                    await client.start_notify(tx, _noop_battery_tx)
                except Exception:
                    pass
            return None

        raw: Optional[bytes] = None
        try:
            await asyncio.sleep(BATTERY_POST_NOTIFY_DELAY)
            # write-without-response: avoids stalling the weaker BLE link when
            # the stack is already busy with 250 Hz EEG + second peripheral.
            await client.write_gatt_char(
                battery_rx_uuid, query_byte, response=False
            )
            raw = await asyncio.wait_for(future, BATTERY_RESPONSE_TIMEOUT)
        except asyncio.TimeoutError:
            raw = None
        finally:
            try:
                await client.stop_notify(tx)
            except Exception:
                pass
            if client.is_connected:
                try:
                    await client.start_notify(tx, _noop_battery_tx)
                except Exception:
                    pass

        return raw

    async def read_one(
        self,
        client,                    # BleakClient (not typed here to avoid import at module top)
        battery_rx_uuid: str,
        battery_tx_uuid: str,
        side: str,
    ) -> Optional[BatteryReading]:
        """Read battery voltage.

        Tries each query byte in ``BATTERY_QUERY_BYTES`` — firmware variants
        differ, and ``b\"q\"`` matches the SDK keep-alive path.

        Temporarily replaces the battery-TX notification handler to capture
        the reply, then **re-subscribes** the no-op handler so link pacing
        matches ``DualBLEConnection`` after connect.
        """
        for query_byte in BATTERY_QUERY_BYTES:
            raw = await self._query_raw_once(
                client, battery_rx_uuid, battery_tx_uuid, query_byte
            )
            if not raw:
                continue
            voltage = parse_battery_payload(raw)
            if voltage is not None:
                return BatteryReading(
                    side=side,
                    voltage=voltage,
                    percentage=voltage_to_percent(voltage),
                    last_updated=datetime.now(),
                )

        return None
