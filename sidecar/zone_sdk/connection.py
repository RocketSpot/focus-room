"""
Zone SDK - BLE Connection Module
Supports dual-device EEG earbuds (left + right)
"""

import asyncio
import logging
import threading
import time
from typing import Optional, Dict, Any, Callable, List
from collections import deque

from bleak import BleakScanner, BleakClient


class _BLEWorker:
    """Owns a dedicated OS thread + asyncio event loop for one BleakClient.

    Matches the hardware-team reference GUI architecture (one QThread per bud),
    which lets the Windows BLE stack negotiate a fast connection interval for
    every link. A shared asyncio loop causes Windows to pin one link at a slow
    (~200 ms) interval, dropping ~80% of samples on the throttled side.
    """

    def __init__(self, name: str):
        self.name = name
        self.loop: asyncio.AbstractEventLoop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self._thread = threading.Thread(
            target=self._run, name=f"ble-{name}", daemon=True
        )
        self._thread.start()
        self._ready.wait()

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self._ready.set()
        try:
            self.loop.run_forever()
        finally:
            try:
                self.loop.close()
            except Exception:
                pass

    async def run(self, coro):
        """Schedule ``coro`` on the worker loop and await its result from
        whichever loop the caller is running on."""
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return await asyncio.wrap_future(fut)

    def run_blocking(self, coro, timeout: Optional[float] = None):
        """Run ``coro`` on the worker loop and block the caller until done."""
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return fut.result(timeout=timeout)

    def stop(self) -> None:
        if self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=2.0)

logger = logging.getLogger(__name__)

CMD_START = b"b"
CMD_STOP = b"s"
CMD_RESET = b"v"
CMD_DEFAULT = b"d"
CMD_TEST_SIGNAL = b"="
SAMPLE_RATE = 250
BLE_PACKET_SIZE = 9        # legacy: [0xA0][seq][CH1 x3][CH2 x3][0xC0]
BLE_PACKET_SIZE_LOFF = 11  # current: ...[LOFF_P][LOFF_N][0xC0], lead-off inline per sample
# CMD_START/CMD_STOP and lead writes: use asyncio.gather for dual-link so each
# worker issues its GATT write without awaiting the peer first.

# ===================== NO SCALE FACTOR - SAVE RAW COUNTS =====================
# We will save RAW ADC counts, not µV values
# Scaling will be done in the processing pipeline

# ===================== DISCOVERY =====================


async def discover_devices(duration: int = 5) -> List[Dict[str, str]]:
    """Scan for BLE devices."""
    devices = await BleakScanner.discover(timeout=duration, return_adv=True)

    found = []
    for addr, (d, adv) in devices.items():
        name = d.name or "Unknown"
        if "zone" not in name.lower():
            continue
        service_uuids = list(adv.service_uuids) if adv.service_uuids else []
        device_info = {
            "name": name,
            "address": d.address,
            "rssi": adv.rssi,
            "service_uuids": service_uuids,
        }
        found.append(device_info)
    return found


async def discover_device_services(address: str) -> List[str]:
    """Connect briefly to a device, discover GATT services, return service UUIDs."""
    try:
        client = BleakClient(address)
        await client.connect(timeout=10.0)
        try:
            await client.get_services()
        except Exception:
            pass
        uuids = [str(s.uuid).lower() for s in client.services]
        await client.disconnect()
        return uuids
    except Exception:
        return []


# ===================== DUAL BLE CONNECTION =====================


class DualBLEConnection:
    """
    Manages connections to both left and right earbud devices.
    Handles data from 4 channels (2 per device).
    SAVES RAW ADC COUNTS (not µV)
    """

    def __init__(self, buffer_size: int = 4096):
        self._client1: Optional[BleakClient] = None
        self._client2: Optional[BleakClient] = None

        # One dedicated thread + asyncio loop per bud. Each BleakClient
        # is created and awaited exclusively on its owning worker, which
        # is what coaxes Windows into giving both links the fast
        # connection interval (see _BLEWorker docstring).
        self._worker1 = _BLEWorker("dev1")
        self._worker2 = _BLEWorker("dev2")

        self._dev1_connected = False
        self._dev2_connected = False
        self._streaming = False

        # UUID profiles (set by Zone)
        self._dev1_profile: Optional[Dict[str, str]] = None  # {"service","rx","tx"}
        self._dev2_profile: Optional[Dict[str, str]] = None
        # Optional extra notify characteristics — subscribing to them
        # matches the hardware-team reference GUI, which subscribes to EEG,
        # Battery, and Touch TX characteristics on every bud. Empirically,
        # doing so stops Windows from throttling one link to a ~210 ms
        # connection interval when two buds are connected.
        self._dev1_extra_tx: list = []
        self._dev2_extra_tx: list = []

        # --- Sample-index synchronization ---
        # sync_map[global_sample_num] = {device_id: (ch1, ch2)}
        self._sync_map: Dict[int, Dict[int, tuple]] = {}
        # Synced 4-channel output buffer: each entry = (ch0, ch1, ch2, ch3)
        self._synced_buffer: deque = deque(maxlen=buffer_size)
        # Global sample counter (unwrapped from 8-bit pkt sample_num)
        self._dev1_global_idx = 0
        self._dev2_global_idx = 0
        self._dev1_prev_raw_num: Optional[int] = None
        self._dev2_prev_raw_num: Optional[int] = None
        # Highest global index seen — used for stale cleanup
        self._global_head = 0
        self._sync_lag_limit = 50

        # Legacy per-channel buffers (kept for single-device mode)
        self._channel_buffers = [deque(maxlen=buffer_size) for _ in range(4)]

        # SEQUENCE-INTEGRITY ADMISSION (hardware team's accumulative-filter spec,
        # 2026-08-19). Every decoded reading is admitted through the firmware's
        # one-byte sample counter BEFORE anything downstream sees it:
        #   delta == 0   -> duplicate, DROP. A re-buffered BLE packet replays part
        #                   of the lead-off tone and steps its phase; enough of
        #                   that and a 42 kOhm electrode measures ~103 Ohm, which
        #                   then reads as "no contact". Duplicated packets stay
        #                   perfectly well-formed, so the counter is the only
        #                   thing that can catch them.
        #   delta > 128  -> replay of samples already held, DROP. Half-modulus
        #                   split: a replayed 10-sample packet lands near the top
        #                   of the byte range, real loss near the bottom.
        #   otherwise    -> ACCEPT; the absolute index advances by the REAL delta,
        #                   so a hole costs coverage instead of shifting every
        #                   later sample to the wrong moment in time.
        # Anti-stall: after 64 consecutive refusals the side re-syncs to whatever
        # is arriving, so a loss larger than 128 cannot reject data forever.
        self._adm = {
            1: {"last": None, "abs": 0, "refusals": 0, "dupes": 0, "replays": 0},
            2: {"last": None, "abs": 0, "refusals": 0, "dupes": 0, "replays": 0},
        }
        self._dev1_received = 0
        self._dev1_dropped = 0
        self._dev1_last_sample = None
        self._dev1_notify_rx = 0  # GATT notifications (may contain many A0…C0 samples)

        self._dev2_received = 0
        self._dev2_dropped = 0
        self._dev2_last_sample = None
        self._dev2_notify_rx = 0

        self._start_time = time.perf_counter()

        self._data_callback: Optional[Callable] = None
        self._stats_callback: Optional[Callable] = None
        self._disconnect_callback: Optional[Callable] = None
        self._impedance_tap: Optional[Callable[[int, float, float], None]] = None
        self._leadoff_tap: Optional[Callable[[int, int, int], None]] = None
        self._last_stats_emit = 0.0
        self._synced_count = 0
        self._stale_count = 0

    

    # ---------- Profile configuration ----------

    def set_device_profiles(
        self,
        dev1_profile: Optional[Dict[str, str]] = None,
        dev2_profile: Optional[Dict[str, str]] = None,
        dev1_extra_tx: Optional[list] = None,
        dev2_extra_tx: Optional[list] = None,
    ):
        """
        dev*_profile example:
        {"service": "...uuid...", "rx": "...uuid...", "tx": "...uuid..."}

        ``dev*_extra_tx`` is an optional list of extra TX characteristic UUIDs
        to subscribe to on each bud (e.g. Battery and Touch TX). Subscribing
        to these matches the reference desktop GUI behaviour and prevents
        Windows from throttling one BLE link when both buds are connected.
        """
        self._dev1_profile = dev1_profile
        self._dev2_profile = dev2_profile
        self._dev1_extra_tx = list(dev1_extra_tx or [])
        self._dev2_extra_tx = list(dev2_extra_tx or [])

    # ---------- Connect / Disconnect ----------

    async def connect_device1(self, address: str) -> bool:
        """Connect to left earbud (channels 0,1)."""
        if not self._dev1_profile:
            logger.error("Device 1 profile not set (UUIDs missing).")
            return False
        return await self._worker1.run(
            self._connect_device_on_worker(
                device_id=1,
                address=address,
                profile=self._dev1_profile,
                on_notify=self._on_dev1_data,
                on_disconnect=self._on_disconnect1,
            )
        )

    async def connect_device2(self, address: str) -> bool:
        """Connect to right earbud (channels 2,3)."""
        if not self._dev2_profile:
            logger.error("Device 2 profile not set (UUIDs missing).")
            return False
        return await self._worker2.run(
            self._connect_device_on_worker(
                device_id=2,
                address=address,
                profile=self._dev2_profile,
                on_notify=self._on_dev2_data,
                on_disconnect=self._on_disconnect2,
            )
        )

    async def _connect_device_on_worker(
        self,
        device_id: int,
        address: str,
        profile: Dict[str, str],
        on_notify: Callable,
        on_disconnect: Callable,
    ) -> bool:
        """Runs on the device's dedicated worker loop. Mirrors the hardware-team
        reference ``ble_service.py`` sequence: BleakClient → connect → sleep →
        start_notify. The critical bit is that this coroutine executes on a
        thread whose only job is this one BLE client — that is what lets
        Windows give every link a fast connection interval."""
        tx_uuid = profile["tx"].lower()
        last_error = None
        for attempt in range(1, 4):
            try:
                logger.info(
                    "Connecting to Device %s: %s (attempt %s/3)",
                    device_id,
                    address,
                    attempt,
                )
                # Register the disconnect callback up-front via the
                # constructor — Bleak >= 0.22 removed the post-connect
                # set_disconnected_callback() method, so passing it here is
                # the only way to be notified when Windows tears the link
                # down unexpectedly. Without this, _dev*_connected stays
                # True forever and the GUI never sees the drop.
                client = BleakClient(address, disconnected_callback=on_disconnect)
                await client.connect(timeout=10.0)
                await asyncio.sleep(0.3)
                await client.start_notify(tx_uuid, on_notify)

                # Subscribe to extra TX characteristics (Battery, Touch, ...)
                # to match the reference GUI. Handlers are no-ops — the
                # subscriptions themselves keep the BLE link from being
                # demoted to a slow connection interval by Windows.
                extras = (
                    self._dev1_extra_tx if device_id == 1 else self._dev2_extra_tx
                )
                logger.info(
                    "Device %s: subscribing to %d extra TX characteristic(s): %s",
                    device_id,
                    len(extras),
                    extras,
                )
                for extra_uuid in extras:
                    try:
                        await client.start_notify(
                            extra_uuid.lower(), self._make_noop_notify(device_id, extra_uuid)
                        )
                        logger.info(
                            "Device %s: extra start_notify OK on %s",
                            device_id,
                            extra_uuid,
                        )
                    except Exception as e:
                        logger.warning(
                            "Device %s extra start_notify on %s failed: %s",
                            device_id,
                            extra_uuid,
                            e,
                        )

                if device_id == 1:
                    self._client1 = client
                    self._dev1_connected = True
                    logger.info("Device 1 connected")
                else:
                    self._client2 = client
                    self._dev2_connected = True
                    logger.info("Device 2 connected")

                return True

            except Exception as e:
                last_error = e
                logger.error("Device %s connection failed: %s", device_id, e)
                if attempt < 3:
                    await asyncio.sleep(1.0)

        if last_error:
            logger.error(
                "Device %s connection failed after retries: %s", device_id, last_error
            )
        return False

    async def disconnect_device1(self):
        await self._worker1.run(self._disconnect_on_worker(1))

    async def disconnect_device2(self):
        await self._worker2.run(self._disconnect_on_worker(2))

    async def _disconnect_on_worker(self, device_id: int) -> None:
        # Mark disconnected BEFORE awaiting client.disconnect(): the bleak
        # disconnected_callback fires during disconnect() and we use this
        # flag to tell intentional vs. unexpected drops apart.
        if device_id == 1:
            self._dev1_connected = False
        else:
            self._dev2_connected = False
        client = self._client1 if device_id == 1 else self._client2
        if client and client.is_connected:
            try:
                await client.disconnect()
            except Exception as e:
                logger.error("Device %s disconnect error: %s", device_id, e)

    # ---------- Streaming ----------

    async def start_streaming(self) -> bool:
        if not self._dev1_connected and not self._dev2_connected:
            logger.error("No devices connected")
            return False

        try:
            # Match ML-DES-APP deskApp/resources/ble/ble_service.py
            # EEGDevice.start_streaming: v → 50 ms → d → 50 ms → b per device.
            # BLEService.start_streaming does left, then right (sequential).
            async def _stream_one(device_id: int) -> None:
                if device_id == 1:
                    if not self._dev1_connected:
                        return
                    await self._send_cmd_dev1(CMD_RESET)
                    await asyncio.sleep(0.05)
                    await self._send_cmd_dev1(CMD_DEFAULT)
                    await asyncio.sleep(0.05)
                    await self._send_cmd_dev1(CMD_START)
                else:
                    if not self._dev2_connected:
                        return
                    await self._send_cmd_dev2(CMD_RESET)
                    await asyncio.sleep(0.05)
                    await self._send_cmd_dev2(CMD_DEFAULT)
                    await asyncio.sleep(0.05)
                    await self._send_cmd_dev2(CMD_START)

            if self._dev1_connected:
                await _stream_one(1)
            if self._dev2_connected:
                await _stream_one(2)

            self._streaming = True
            self._reset_stream_session_throughput_stats()
            logger.info("✓ Streaming started")
            return True

        except Exception as e:
            logger.error(f"Failed to start streaming: {e}")
            return False

    async def stop_streaming(self) -> bool:
        try:
            if self._dev1_connected and self._dev2_connected:
                await asyncio.gather(
                    self._send_cmd_dev1(CMD_STOP),
                    self._send_cmd_dev2(CMD_STOP),
                )
            else:
                if self._dev1_connected:
                    await self._send_cmd_dev1(CMD_STOP)
                if self._dev2_connected:
                    await self._send_cmd_dev2(CMD_STOP)

            self._streaming = False
            logger.info("✓ Streaming stopped")
            return True
        except Exception as e:
            logger.error(f"Failed to stop streaming: {e}")
            return False

    async def _send_cmd_dev1(self, cmd: bytes):
        if (
            not self._client1
            or not self._client1.is_connected
            or not self._dev1_profile
        ):
            return
        await self._worker1.run(self._write_gatt_on_worker(1, self._dev1_profile["rx"], cmd))

    async def _send_cmd_dev2(self, cmd: bytes):
        if (
            not self._client2
            or not self._client2.is_connected
            or not self._dev2_profile
        ):
            return
        await self._worker2.run(self._write_gatt_on_worker(2, self._dev2_profile["rx"], cmd))

    async def _write_gatt_on_worker(self, device_id: int, char_uuid: str, payload: bytes) -> None:
        client = self._client1 if device_id == 1 else self._client2
        if not client or not client.is_connected:
            return
        try:
            await client.write_gatt_char(char_uuid, payload, response=False)
        except Exception as e:
            logger.error("Device %s send error: %s", device_id, e)

    async def send_reset(self):
        """Send reset command to any connected devices."""
        if self._dev1_connected:
            await self._send_cmd_dev1(CMD_RESET)
        if self._dev2_connected:
            await self._send_cmd_dev2(CMD_RESET)

    async def send_default(self):
        """Send default command to any connected devices."""
        if self._dev1_connected:
            await self._send_cmd_dev1(CMD_DEFAULT)
        if self._dev2_connected:
            await self._send_cmd_dev2(CMD_DEFAULT)

    async def send_test_signal(self):
        """Send test signal command to any connected devices."""
        if self._dev1_connected:
            await self._send_cmd_dev1(CMD_TEST_SIGNAL)
        if self._dev2_connected:
            await self._send_cmd_dev2(CMD_TEST_SIGNAL)

    # ---------- Notifications ----------

    def _noop_notify(self, sender, data: bytearray) -> None:
        """No-op handler for extra characteristics we subscribe to solely
        to keep the BLE connection interval fast."""
        return

    def _make_noop_notify(self, device_id: int, uuid: str):
        """Return a no-op handler for extra characteristics we subscribe to
        solely to keep the BLE connection interval fast."""
        def handler(sender, data: bytearray) -> None:
            return
        return handler

    def _on_dev1_data(self, sender, data: bytearray):
        self._dev1_notify_rx += 1
        self._parse_packets(data, device_id=1)

    def _on_dev2_data(self, sender, data: bytearray):
        self._dev2_notify_rx += 1
        self._parse_packets(data, device_id=2)

    def _parse_packets(self, data: bytearray, device_id: int):
        """Accept BOTH packet layouts the firmware ships.

            legacy  9 bytes : [0xA0][seq][CH1 x3][CH2 x3][0xC0]
            current 11 bytes: [0xA0][seq][CH1 x3][CH2 x3][LOFF_P][LOFF_N][0xC0]

        The 11-byte form carries per-channel lead-off bits INLINE with every
        sample, which is the only way to know about electrode contact while a
        session is actually running: the SDK's Goertzel impedance check has to
        inject a current and is therefore mutually exclusive with streaming, so
        it can only run before a guest starts reading. Reading these two bytes
        gives the operator a live contact signal for free, on the samples that
        were arriving anyway.

        The longer form is tried first: a run of 11-byte packets can be misread
        as 9-byte ones at the wrong offset, but not the reverse.
        """
        data_len = len(data)
        i = 0
        while i < data_len:
            matched = False
            for size in (BLE_PACKET_SIZE_LOFF, BLE_PACKET_SIZE):
                if i + size <= data_len and data[i] == 0xA0 and data[i + size - 1] == 0xC0:
                    self._process_packet(bytes(data[i: i + size]), device_id)
                    i += size
                    matched = True
                    break
            if not matched:
                i += 1


    def _unwrap_sample_num(self, raw_num: int, device_id: int) -> int:
        """Convert 8-bit wrapping sample_num to monotonic global index."""
        if device_id == 1:
            prev = self._dev1_prev_raw_num
            if prev is not None:
                diff = (raw_num - prev) & 0xFF
                if diff > 128:
                    diff -= 256
                self._dev1_global_idx += diff
            else:
                # First packet: align to current head so devices stay in sync
                self._dev1_global_idx = self._global_head
            self._dev1_prev_raw_num = raw_num
            return self._dev1_global_idx
        else:
            prev = self._dev2_prev_raw_num
            if prev is not None:
                diff = (raw_num - prev) & 0xFF
                if diff > 128:
                    diff -= 256
                self._dev2_global_idx += diff
            else:
                # First packet: align to current head so devices stay in sync
                self._dev2_global_idx = self._global_head
            self._dev2_prev_raw_num = raw_num
            return self._dev2_global_idx

    def _process_packet(self, pkt: bytes, device_id: int):
        raw_num = pkt[1]

        # admission first: a dropped packet must never be spliced shut, and a
        # duplicated one must never be admitted twice (see _adm above)
        adm = self._adm[1 if device_id == 1 else 2]
        if adm["last"] is None:
            adm["last"] = raw_num
            adm["abs"] += 1
        else:
            delta = (raw_num - adm["last"] + 256) % 256
            if delta == 0:
                adm["dupes"] += 1
                return
            if delta > 128:
                adm["refusals"] += 1
                adm["replays"] += 1
                if adm["refusals"] < 64:
                    return
                # anti-stall: re-sync to whatever is arriving
                adm["last"] = raw_num
                adm["abs"] += 1
                adm["refusals"] = 0
            else:
                adm["last"] = raw_num
                adm["abs"] += delta       # a gap advances by its true size
                adm["refusals"] = 0
        abs_idx = adm["abs"]

        # lead-off bits, when the firmware sends the longer packet. A set bit means
        # that pin is OFF the skin. Operator-facing only: it never gates the room,
        # and it is never shown to a guest.
        if len(pkt) >= BLE_PACKET_SIZE_LOFF and self._leadoff_tap is not None:
            try:
                self._leadoff_tap(device_id, pkt[8], pkt[9])
            except Exception:
                logger.exception("lead-off tap error")

        # Extract 24-bit signed integers (RAW ADC COUNTS)
        ch1_raw = (pkt[2] << 16) | (pkt[3] << 8) | pkt[4]
        if ch1_raw & 0x800000:
            ch1_raw -= 0x1000000

        ch2_raw = (pkt[5] << 16) | (pkt[6] << 8) | pkt[7]
        if ch2_raw & 0x800000:
            ch2_raw -= 0x1000000

        # Track statistics
        if device_id == 1:
            if self._dev1_last_sample is not None:
                expected = (self._dev1_last_sample + 1) & 0xFF
                if raw_num != expected:
                    self._dev1_dropped += (raw_num - expected) & 0xFF
            self._dev1_last_sample = raw_num
            self._dev1_received += 1
        else:
            if self._dev2_last_sample is not None:
                expected = (self._dev2_last_sample + 1) & 0xFF
                if raw_num != expected:
                    self._dev2_dropped += (raw_num - expected) & 0xFF
            self._dev2_last_sample = raw_num
            self._dev2_received += 1

        # Always use channel buffers — works reliably for both single and dual mode
        if device_id == 1:
            self._channel_buffers[0].append(float(ch1_raw))
            self._channel_buffers[1].append(float(ch2_raw))
        else:
            self._channel_buffers[2].append(float(ch1_raw))
            self._channel_buffers[3].append(float(ch2_raw))

        if self._data_callback:
            self._data_callback(device_id, raw_num, float(ch1_raw), float(ch2_raw))

        if self._stats_callback and device_id == 1:
            now = time.perf_counter()
            if now - self._last_stats_emit >= 1.0:
                self._last_stats_emit = now
                self._stats_callback(self.get_stats())

        if self._impedance_tap is not None:
            try:
                # the ABSOLUTE index rides along: the impedance DFT is evaluated
                # against each sample's true position in the stream, so a dropped
                # packet costs coverage instead of rotating the tone's phase and
                # collapsing the estimate toward a fake perfect contact
                self._impedance_tap(device_id, float(ch1_raw), float(ch2_raw), abs_idx)
            except Exception:
                logger.exception("impedance tap error")

    # ---------- Disconnect callbacks ----------

    def _on_disconnect1(self, client):
        # Skip if we already know dev1 is down — that means this is an
        # intentional disconnect (disconnect_device1 / rescue) or a stale
        # callback from a previous client. Only unexpected drops should
        # propagate to listeners.
        if not self._dev1_connected:
            return
        logger.warning("⚠ Device 1 (left) disconnected")
        self._dev1_connected = False
        if self._disconnect_callback:
            self._disconnect_callback("left")

    def _on_disconnect2(self, client):
        if not self._dev2_connected:
            return
        logger.warning("⚠ Device 2 (right) disconnected")
        self._dev2_connected = False
        if self._disconnect_callback:
            self._disconnect_callback("right")

    # ---------- Read / Stats ----------

    def refresh_link_state(self) -> None:
        """Align *_connected flags with ``BleakClient.is_connected``.

        Disconnect callbacks can be delayed or skipped on some stacks while the
        client already reports the link as down; polling keeps status and stats
        accurate for menus and diagnostics. When polling detects a
        connected→disconnected transition we also fire the disconnect
        callback so GUI listeners get notified even if the Bleak-level
        callback never arrives.
        """
        dev1_link_down = not (self._client1 and self._client1.is_connected)
        if self._dev1_connected and dev1_link_down:
            self._dev1_connected = False
            if self._disconnect_callback:
                try:
                    self._disconnect_callback("left")
                except Exception:
                    logger.exception("disconnect callback error (left, polled)")

        dev2_link_down = not (self._client2 and self._client2.is_connected)
        if self._dev2_connected and dev2_link_down:
            self._dev2_connected = False
            if self._disconnect_callback:
                try:
                    self._disconnect_callback("right")
                except Exception:
                    logger.exception("disconnect callback error (right, polled)")

    def read_data(
        self, n_samples: int = None, allow_partial: bool = False, pad_value: float = 0.0
    ) -> Optional[Dict[str, Any]]:
        self.refresh_link_state()
        if n_samples is None:
            n_samples = SAMPLE_RATE

        # Determine active channels based on connected devices
        if self._dev1_connected and self._dev2_connected:
            active_indices = [0, 1, 2, 3]
        elif self._dev1_connected:
            active_indices = [0, 1]
        elif self._dev2_connected:
            active_indices = [2, 3]
        else:
            return None

        buf_lens = [len(self._channel_buffers[i]) for i in active_indices]
        available = min(buf_lens)
        if available == 0:
            return None

        take_n = min(n_samples, available)
        channels_data = []
        for i in active_indices:
            channels_data.append(
                [self._channel_buffers[i].popleft() for _ in range(take_n)]
            )

        return {
            "channels": channels_data,
            "sample_rate": SAMPLE_RATE,
            "n_samples": take_n,
                "n_channels": len(channels_data),
                "valid_lengths": [take_n] * len(channels_data),
            }

    def reset_dev1_stats(self) -> None:
        """Zero out Dev1's rate counters and restart the global stats clock
        so post-reconnect rate measurements reflect only the new link.
        Dev2 counters are left alone."""
        # SEQUENCE-INTEGRITY ADMISSION (hardware team's accumulative-filter spec,
        # 2026-08-19). Every decoded reading is admitted through the firmware's
        # one-byte sample counter BEFORE anything downstream sees it:
        #   delta == 0   -> duplicate, DROP. A re-buffered BLE packet replays part
        #                   of the lead-off tone and steps its phase; enough of
        #                   that and a 42 kOhm electrode measures ~103 Ohm, which
        #                   then reads as "no contact". Duplicated packets stay
        #                   perfectly well-formed, so the counter is the only
        #                   thing that can catch them.
        #   delta > 128  -> replay of samples already held, DROP. Half-modulus
        #                   split: a replayed 10-sample packet lands near the top
        #                   of the byte range, real loss near the bottom.
        #   otherwise    -> ACCEPT; the absolute index advances by the REAL delta,
        #                   so a hole costs coverage instead of shifting every
        #                   later sample to the wrong moment in time.
        # Anti-stall: after 64 consecutive refusals the side re-syncs to whatever
        # is arriving, so a loss larger than 128 cannot reject data forever.
        # ONLY device 1's admission epoch resets - rebuilding the whole dict
        # also zeroed device 2's absolute index, and an estimator ring still
        # holding samples at the old large positions would then splice two
        # position epochs into one window (arbitrary relative tone phase, so
        # the amplitude can partially cancel into the pass band).
        self._adm[1] = {"last": None, "abs": 0, "refusals": 0, "dupes": 0, "replays": 0}
        self._dev1_received = 0
        self._dev1_dropped = 0
        self._dev1_last_sample = None
        self._dev1_prev_raw_num = None
        self._dev1_notify_rx = 0
        self._start_time = time.perf_counter()

    def reset_dev2_stats(self) -> None:
        self._dev2_received = 0
        self._dev2_dropped = 0
        self._dev2_last_sample = None
        self._dev2_prev_raw_num = None
        self._dev2_notify_rx = 0
        self._start_time = time.perf_counter()

    def _reset_stream_session_throughput_stats(self) -> None:
        """Call when CMD_START begins a new streaming session.

        ``get_stats()`` uses ``received / (now - _start_time)``. Without this,
        a second ``start_streaming()`` (e.g. after battery) leaves cumulative
        packet counts but resets ``_start_time``, producing nonsense rates
        (e.g. 1486/s). Also clear ``_dev*_last_sample`` so a pause does not
        inflate ``dropped`` across the stop/start boundary.
        """
        self._dev1_received = 0
        self._dev2_received = 0
        self._dev1_dropped = 0
        self._dev2_dropped = 0
        self._dev1_last_sample = None
        self._dev2_last_sample = None
        self._dev1_notify_rx = 0
        self._dev2_notify_rx = 0
        self._start_time = time.perf_counter()

    def get_stats(self) -> Dict[str, Any]:
        self.refresh_link_state()
        elapsed = time.perf_counter() - self._start_time
        if elapsed < 0.001:
            elapsed = 0.001

        return {
            "dev1": {
                "connected": self._dev1_connected,
                # One decoded A0…C0 frame == one EEG sample (ch1+ch2); notify may carry several.
                "received": self._dev1_received,
                "dropped": self._dev1_dropped,
                "rate": self._dev1_received / elapsed,
                "notifications": self._dev1_notify_rx,
                "notify_rate": self._dev1_notify_rx / elapsed,
            },
            "dev2": {
                "connected": self._dev2_connected,
                "received": self._dev2_received,
                "dropped": self._dev2_dropped,
                "rate": self._dev2_received / elapsed,
                "notifications": self._dev2_notify_rx,
                "notify_rate": self._dev2_notify_rx / elapsed,
            },
            "elapsed": elapsed,
        }

    def set_data_callback(self, callback: Callable):
        self._data_callback = callback

    def set_stats_callback(self, callback: Callable):
        self._stats_callback = callback

    def set_disconnect_callback(self, callback: Callable):
        self._disconnect_callback = callback

    def set_leadoff_tap(self, callback: Optional[Callable[[int, int, int], None]]):
        """Receive (device_id, loff_p, loff_n) from every 11-byte packet.

        Unlike the impedance estimator this needs no injected current and does
        not interrupt streaming, so contact can be watched DURING a reading
        rather than only before one.
        """
        self._leadoff_tap = callback

    def set_impedance_tap(self, callback: Optional[Callable[[int, float, float], None]]):
        """Install a tap that receives (device_id, ch1_raw, ch2_raw) per sample.

        Pass None to remove. Used by the impedance DSP to consume live EEG samples
        without going through the chunked read_data() path.
        """
        self._impedance_tap = callback

    async def write_eeg_rx_text(self, side: str, text: str) -> bool:
        """Write a multi-byte ASCII command (e.g. 'lead', 'lead0') to the EEG RX
        characteristic. Returns True on success.

        When ``side == "both"`` and both buds are connected, writes run in
        **parallel** on the two BLE workers so neither link is left waiting."""
        payload = text.encode("utf-8")

        async def _write_left() -> bool:
            if not (self._client1 and self._client1.is_connected and self._dev1_profile):
                return False
            try:
                await self._worker1.run(
                    self._write_gatt_on_worker(1, self._dev1_profile["rx"], payload)
                )
                return True
            except Exception as e:
                logger.error("write_eeg_rx_text left failed: %s", e)
                return False

        async def _write_right() -> bool:
            if not (self._client2 and self._client2.is_connected and self._dev2_profile):
                return False
            try:
                await self._worker2.run(
                    self._write_gatt_on_worker(2, self._dev2_profile["rx"], payload)
                )
                return True
            except Exception as e:
                logger.error("write_eeg_rx_text right failed: %s", e)
                return False

        if (
            side == "both"
            and self._dev1_connected
            and self._dev2_connected
        ):
            ok_l, ok_r = await asyncio.gather(_write_left(), _write_right())
            return ok_l and ok_r

        coros = []
        if side in ("left", "both"):
            coros.append(_write_left())
        if side in ("right", "both"):
            coros.append(_write_right())
        if not coros:
            return False

        results = await asyncio.gather(*coros, return_exceptions=False)

        return any(results)

    async def run_on_device(self, device_id: int, coro):
        """Run an arbitrary coroutine on the worker loop that owns device
        ``device_id``. Used by callers (e.g. battery read) that need to touch
        a BleakClient directly — they must do so on that client's loop."""
        worker = self._worker1 if device_id == 1 else self._worker2
        return await worker.run(coro)

    def is_connected(self) -> bool:
        self.refresh_link_state()
        return self._dev1_connected or self._dev2_connected

    def is_fully_connected(self) -> bool:
        self.refresh_link_state()
        return self._dev1_connected and self._dev2_connected

    def shutdown(self) -> None:
        """Stop both BLE worker threads. Call during teardown."""
        try:
            self._worker1.stop()
        except Exception:
            pass
        try:
            self._worker2.stop()
        except Exception:
            pass
